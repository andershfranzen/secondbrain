import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { statfs } from "node:fs/promises";
import {
  type Config,
  AppError,
  TextCapture,
  MessageInput,
  ManualItem,
  Candidate,
  kinds,
  hash,
  uuid,
  z,
  fail,
  randomUUID,
} from "@secondbrain/shared";
import {
  Database,
  one,
  camel,
  enqueue,
  migrationManifest,
} from "@secondbrain/database";
import { provider, ProviderError, type AIProvider } from "@secondbrain/ai";
import {
  captureText,
  captureAudio,
  getItem,
  manualSource,
  createCandidate,
  patchItem,
  correctMemory,
  sourceFor,
  postMessage,
  search,
  deletionImpact,
  requestDeletion,
  openPrivate,
  initStorage,
  undoTurn,
} from "@secondbrain/memory";
import { auth } from "./auth.js";
function page(query: any) {
  const input = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().max(1000).optional(),
    })
    .parse(query);
  let cursor: { createdAt: string; id: string } | null = null;
  if (input.cursor) {
    try {
      cursor = z
        .object({ createdAt: z.iso.datetime({ offset: true }), id: uuid })
        .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()));
    } catch {
      fail(400, "INVALID_CURSOR", "Invalid page cursor.");
    }
  }
  return { ...input, cursor };
}
async function listing(
  db: Database,
  table: string,
  query: any,
  conditions: string[] = [],
  values: any[] = [],
) {
  const p = page(query);
  if (p.cursor) {
    values.push(p.cursor.createdAt, p.cursor.id);
    conditions.push(
      `(created_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(p.limit + 1);
  const rows = (
    await db.query(
      `SELECT * FROM ${table} ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`,
      values,
    )
  ).rows;
  const more = rows.length > p.limit;
  rows.splice(p.limit);
  const last = rows.at(-1);
  return {
    items: rows,
    nextCursor:
      more && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.created_at.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
}
function revision(req: any) {
  if (!req.headers["if-match"])
    fail(428, "REVISION_REQUIRED", "Send the current item revision.");
  const match = /^"(\d+)"$/.exec(req.headers["if-match"]);
  if (!match) fail(400, "INVALID_REVISION", "Invalid item revision.");
  return Number(match[1]);
}
function id(req: any): string {
  return uuid.parse(req.params.id);
}
export async function buildServer(
  c: Config,
  db = new Database(c.DATABASE_URL),
  ai: AIProvider = provider(c, async () => {
    const s = await one(
      db,
      "SELECT cloud_consent_at,maintenance FROM app_settings",
    );
    if (!s?.cloud_consent_at)
      throw new ProviderError("CONSENT_REQUIRED", false);
    if (s.maintenance) throw new ProviderError("MAINTENANCE", true);
  }),
) {
  const requiredMigrations = await migrationManifest();
  const app = Fastify({
    logger: {
      level: c.LOG_LEVEL,
      redact: ["req.headers.cookie", "req.headers.authorization", "req.body"],
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    requestTimeout: 300000,
    trustProxy: false,
  });
  await initStorage(c);
  await app.register(cookie, { secret: c.SESSION_SECRET });
  await app.register(multipart, {
    // Keep the original name only long enough to reject path-shaped input.
    // Storage always uses a server-generated key.
    preservePath: true,
    limits: { files: 1, fields: 1, fileSize: c.MAX_UPLOAD_BYTES, parts: 2 },
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  const security = auth(db, c);
  app.addHook("onRequest", security.protect);
  app.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    return payload;
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Check the supplied fields.",
          requestId: req.id,
          details: error.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        },
      });
    const e =
      error instanceof AppError
        ? error
        : new AppError(
            (error as any).statusCode ?? 500,
            "REQUEST_FAILED",
            (error as any).statusCode === 413
              ? "Upload is too large."
              : "The request could not be completed.",
          );
    if (e.status >= 500)
      app.log.error({ requestId: req.id, code: e.code }, "Request failed");
    return reply.code(e.status).send({
      error: {
        code: e.code,
        message: e.message,
        requestId: req.id,
        ...(e.details ? { details: e.details } : {}),
      },
    });
  });
  await security.register(app);
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      const applied = (
        await db.query("SELECT name,sha256 FROM schema_migrations")
      ).rows;
      if (
        applied.length !== requiredMigrations.length ||
        !requiredMigrations.every((m) =>
          applied.some((a) => a.name === m.name && a.sha256 === m.sha256),
        )
      )
        return reply.code(503).send({ status: "not_ready" });
      await db.query("SELECT 1 FROM app_settings");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  app.get("/api/v1/me", async () => ({
    ...(camel(await one(db, "SELECT * FROM app_settings")) as any),
    capabilities: {
      text: true,
      audio: true,
      ai: ai.configured,
      transcription: ai.capabilities?.transcription !== false && ai.configured,
      semanticSearch: ai.capabilities?.embeddings !== false && ai.configured,
      agent: ai.configured,
      provider: c.AI_PROVIDER,
      embeddingModel: ai.model,
    },
  }));
  app.patch("/api/v1/settings", async (req) => {
    const body = z
      .strictObject({
        timezone: z.string().max(100).optional(),
        audioRetentionDays: z.int().min(0).max(3650).optional(),
        acknowledgeShorterRetention: z.boolean().optional(),
        cloudConsent: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.timezone)
      try {
        new Intl.DateTimeFormat("en", { timeZone: body.timezone });
      } catch {
        fail(422, "INVALID_TIMEZONE", "Choose a valid IANA timezone.");
      }
    return db.transaction(async (tx) => {
      const old = (await one(tx, "SELECT * FROM app_settings FOR UPDATE"))!;
      if (
        body.audioRetentionDays !== undefined &&
        body.audioRetentionDays < old.audio_retention_days &&
        !body.acknowledgeShorterRetention
      )
        fail(
          422,
          "ACKNOWLEDGMENT_REQUIRED",
          "A shorter retention period can delete existing recordings. Confirm to continue.",
        );
      if (body.timezone)
        await tx.query("UPDATE app_settings SET timezone=$1,updated_at=now()", [
          body.timezone,
        ]);
      if (body.audioRetentionDays !== undefined) {
        await tx.query(
          "UPDATE app_settings SET audio_retention_days=$1,updated_at=now()",
          [body.audioRetentionDays],
        );
        await tx.query(
          `UPDATE attachments SET retain_until=created_at+($1*interval '1 day') WHERE state='available'`,
          [body.audioRetentionDays],
        );
      }
      if (body.cloudConsent !== undefined) {
        await tx.query(
          "UPDATE app_settings SET cloud_consent_at=CASE WHEN $1 THEN now() ELSE NULL END,updated_at=now()",
          [body.cloudConsent],
        );
        if (!body.cloudConsent) {
          await tx.query(
            `UPDATE processing_jobs SET attempts=greatest(0,attempts-CASE WHEN status='running' THEN 1 ELSE 0 END),status='retry_wait',blocked_reason='CONSENT_REQUIRED',lease_token=NULL,lease_until=NULL WHERE kind IN('converse','transcribe','embed') AND status IN('running','pending','retry_wait')`,
          );
        } else
          await tx.query(
            `UPDATE processing_jobs SET blocked_reason=NULL WHERE blocked_reason='CONSENT_REQUIRED'`,
          );
      }
      return camel(await one(tx, "SELECT * FROM app_settings"));
    });
  });
  app.post("/api/v1/captures/text", async (req, reply) => {
    const result = await captureText(db, TextCapture.parse(req.body));
    reply.code(result.replay ? 200 : 201);
    return camel(result);
  });
  app.post("/api/v1/captures/audio", async (req, reply) => {
    const parts = req.parts(),
      first = await parts.next();
    if (
      first.done ||
      first.value.type !== "field" ||
      first.value.fieldname !== "clientCaptureId"
    )
      fail(400, "CAPTURE_ID_REQUIRED", "Send the capture ID before the audio.");
    const clientId = uuid.parse(first.value.value),
      second = await parts.next();
    if (
      second.done ||
      second.value.type !== "file" ||
      second.value.fieldname !== "audio"
    )
      fail(400, "MISSING_AUDIO", "Select an audio file.");
    const filename = second.value.filename;
    if (
      !filename ||
      filename.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/.test(filename) ||
      filename === "." ||
      filename === ".."
    ) {
      second.value.file.resume();
      fail(
        400,
        "INVALID_AUDIO_FILENAME",
        "Use an audio filename without a path.",
      );
    }
    const result = await captureAudio(
      db,
      c,
      second.value.file,
      clientId,
      second.value.mimetype,
      async () => {
        if (!(await parts.next()).done)
          fail(
            400,
            "INVALID_UPLOAD",
            "Only capture ID and audio are accepted.",
          );
      },
    );
    return reply.code(result.replay ? 200 : 201).send(camel(result));
  });
  app.get("/api/v1/captures/by-client-id/:id", async (req) => {
    const r = await one(
      db,
      `SELECT * FROM conversations WHERE client_capture_id=$1 AND state<>'deleting'`,
      [id(req)],
    );
    if (!r) fail(404, "NOT_FOUND", "Capture not found.");
    return camel({ conversation: r });
  });
  app.get("/api/v1/conversations", async (req) => {
    const q = z
        .object({
          mode: z
            .enum(["text", "audio", "recall", "manual", "chat"])
            .optional(),
          state: z.string().optional(),
          q: z.string().max(500).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
        })
        .parse(req.query),
      conditions = [`state<>'deleting'`],
      values: any[] = [];
    for (const [col, key] of [
      ["mode", "mode"],
      ["state", "state"],
    ] as const)
      if (q[key]) {
        values.push(q[key]);
        conditions.push(`${col}=$${values.length}`);
      }
    if (q.q) {
      values.push(`%${q.q.replace(/[\\%_]/g, "\\$&")}%`);
      conditions.push(
        `id IN(SELECT conversation_id FROM messages WHERE content ILIKE $${values.length})`,
      );
    }
    if (q.from) {
      values.push(q.from);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (q.to) {
      values.push(q.to);
      conditions.push(`created_at <= $${values.length}`);
    }
    return camel(
      await listing(db, "conversations", req.query, conditions, values),
    );
  });
  app.get("/api/v1/conversations/:id", async (req) => {
    const conversation = await one(
      db,
      `SELECT * FROM conversations WHERE id=$1 AND state<>'deleting'`,
      [id(req)],
    );
    if (!conversation) fail(404, "NOT_FOUND", "Capture not found.");
    const messages = (
      await db.query(
        "SELECT m.*,s.id AS source_id FROM messages m LEFT JOIN sources s ON s.message_id=m.id AND s.available WHERE m.conversation_id=$1 ORDER BY ordinal",
        [id(req)],
      )
    ).rows;
    const attachments = (
      await db.query(
        "SELECT id,media_type,byte_size,duration_ms,state FROM attachments WHERE conversation_id=$1",
        [id(req)],
      )
    ).rows;
    const jobs = (
      await db.query(
        "SELECT id,kind,status,blocked_reason,attempts,error_code,run_after FROM processing_jobs WHERE conversation_id=$1 ORDER BY created_at",
        [id(req)],
      )
    ).rows;
    const turns = (
      await db.query(
        "SELECT id,job_id,message_id,status,message_kind,reply,actions,steps,model,created_at,(status='completed' AND undo IS NOT NULL) AS can_undo FROM agent_turns WHERE conversation_id=$1 ORDER BY created_at",
        [id(req)],
      )
    ).rows;
    return camel({
      conversation,
      messages,
      attachments,
      jobs,
      turns,
    });
  });
  app.get("/api/v1/conversations/:id/deletion-impact", async (req) =>
    camel(await deletionImpact(db, id(req))),
  );
  app.delete("/api/v1/conversations/:id", async (req, reply) => {
    z.strictObject({ confirm: z.literal(true) }).parse(req.body);
    const job = await db.transaction((tx) => requestDeletion(tx, id(req), c));
    return reply.code(202).send({ jobId: job.id });
  });
  app.post("/api/v1/conversations/:id/retry", async (req, reply) => {
    await db.transaction(async (tx) => {
      const failed = await one(
        tx,
        `SELECT * FROM processing_jobs WHERE conversation_id=$1 AND status='failed' ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [id(req)],
      );
      if (!failed)
        fail(409, "NOT_FAILED", "No failed processing stage to retry.");
      await tx.query(
        `UPDATE processing_jobs SET status='pending',attempts=0,error_code=NULL,run_after=now(),blocked_reason=NULL WHERE id=$1`,
        [failed.id],
      );
      await tx.query(
        `UPDATE conversations SET state='queued' WHERE id=$1 AND mode IN('text','audio') AND state='failed'`,
        [id(req)],
      );
      await tx.query(
        `INSERT INTO audit_events(kind,reference_id,reason) VALUES('manual_retry',$1,'User requested a new bounded attempt budget')`,
        [failed.id],
      );
    });
    return reply.code(202).send({ status: "queued" });
  });
  app.get("/api/v1/sources/:id", async (req) =>
    camel(await sourceFor(db, id(req))),
  );
  app.get("/api/v1/attachments/:id/content", async (req, reply) => {
    const a = await one(
      db,
      `SELECT a.* FROM attachments a JOIN conversations c ON c.id=a.conversation_id WHERE a.id=$1 AND c.state<>'deleting'`,
      [id(req)],
    );
    if (!a) fail(404, "NOT_FOUND", "Recording not found.");
    if (a.state !== "available")
      fail(
        410,
        "AUDIO_PURGED",
        "The recording has expired; its transcript is still available.",
      );
    const file = await openPrivate(c, a.storage_key),
      size = Number(a.byte_size);
    let start = 0,
      end = size - 1;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (!m[1] && !m[2])) {
        await file.close();
        return reply
          .code(416)
          .header("Content-Range", `bytes */${size}`)
          .send();
      }
      if (!m[1]) start = Math.max(0, size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= size) {
        await file.close();
        return reply
          .code(416)
          .header("Content-Range", `bytes */${size}`)
          .send();
      }
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    return reply
      .header("Content-Type", a.media_type)
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", end - start + 1)
      .send(file.createReadStream({ start, end }));
  });
  app.get("/api/v1/items", async (req) => {
    const q = z
        .object({
          kind: z
            .enum(["memory", "project", "task", "idea", "entity"])
            .optional(),
          status: z.string().max(50).optional(),
          lifecycle: z.enum(["active", "archived", "superseded"]).optional(),
          projectId: uuid.optional(),
          q: z.string().max(500).optional(),
        })
        .parse(req.query),
      cond = [`projection_state='valid'`],
      v: any[] = [];
    for (const [col, value] of [
      ["kind", q.kind],
      ["lifecycle", q.lifecycle ?? "active"],
    ] as const)
      if (value) {
        v.push(value);
        cond.push(`${col}=$${v.length}`);
      }
    // "open" includes work in progress; "done" covers completed or cancelled.
    if (q.status) {
      v.push(
        q.status === "open"
          ? ["open", "in_progress"]
          : q.status === "done"
            ? ["completed", "cancelled"]
            : [q.status],
      );
      cond.push(`status=ANY($${v.length}::text[])`);
    }
    if (q.projectId) {
      v.push(q.projectId);
      cond.push(
        `(project_id=$${v.length} OR id IN(SELECT from_item_id FROM relationships WHERE to_item_id=$${v.length}))`,
      );
    }
    if (q.q) {
      v.push(q.q);
      cond.push(
        `to_tsvector('simple',title||' '||content) @@ websearch_to_tsquery('simple',$${v.length})`,
      );
    }
    return camel(await listing(db, "item_records", req.query, cond, v));
  });
  app.post("/api/v1/items", async (req, reply) => {
    const input = ManualItem.parse(req.body);
    const item = await db.transaction(async (tx) => {
      const source = await manualSource(tx, input.content),
        base = {
          localId: randomUUID(),
          title: input.title,
          content: input.content,
          epistemicState: "confirmed",
          confidence: 1,
          commitment: input.kind === "task" ? "explicit" : "none",
          due: null,
          evidence: [
            {
              sourceId: source.id,
              start: 0,
              end: [...input.content].length,
              quote: input.content,
            },
          ],
        };
      const candidate = Candidate.parse({
        ...base,
        kind: input.kind,
        ...(input.kind === "memory"
          ? { category: input.category ?? "context" }
          : {}),
        ...(input.kind === "entity"
          ? { entityType: input.entityType ?? "concept" }
          : {}),
        ...(input.kind === "project"
          ? {
              outcome: null,
              currentState: input.content,
              lastDecision: null,
              blocker: null,
              nextStep: null,
            }
          : {}),
      });
      return createCandidate(
        tx,
        candidate,
        `manual:${source.id}`,
        "user",
        input.projectId ?? null,
      );
    });
    return reply
      .code(201)
      .header("ETag", `"${item.revision}"`)
      .send(camel(item));
  });
  app.get("/api/v1/items/:id", async (req, reply) => {
    const item = await getItem(db, id(req)),
      citations = (
        await db.query(
          `SELECT i.*,m.conversation_id FROM item_sources i JOIN sources s ON s.id=i.source_id JOIN messages m ON m.id=s.message_id WHERE i.item_id=$1 AND s.available`,
          [id(req)],
        )
      ).rows,
      relationships = (
        await db.query(
          "SELECT r.*,k.title AS related_title FROM relationships r JOIN knowledge_items k ON k.id=CASE WHEN r.from_item_id=$1 THEN r.to_item_id ELSE r.from_item_id END WHERE r.from_item_id=$1 OR r.to_item_id=$1",
          [id(req)],
        )
      ).rows;
    return reply
      .header("ETag", `"${item.revision}"`)
      .send(camel({ ...item, citations, relationships }));
  });
  app.patch("/api/v1/items/:id", async (req, reply) => {
    const item = await db.transaction((tx) =>
      patchItem(tx, id(req), revision(req), req.body),
    );
    return reply.header("ETag", `"${item.revision}"`).send(camel(item));
  });
  app.post("/api/v1/items/:id/corrections", async (req, reply) => {
    const body = z
        .strictObject({
          assertion: z.string().min(1).max(10000),
          reason: z.string().min(1).max(2000),
        })
        .parse(req.body),
      item = await db.transaction((tx) =>
        correctMemory(tx, id(req), revision(req), body.assertion, body.reason),
      );
    return reply
      .code(201)
      .header("ETag", `"${item.revision}"`)
      .send(camel(item));
  });
  app.get("/api/v1/items/:id/events", async (req) => {
    await getItem(db, id(req));
    return camel(
      await listing(db, "memory_events", req.query, ["item_id=$1"], [id(req)]),
    );
  });
  app.get("/api/v1/search", async (req) => {
    const q = z
      .object({
        q: z.string().min(1).max(4000),
        projectId: uuid.optional(),
        kind: z.enum(kinds).optional(),
        historical: z
          .enum(["true", "false"])
          .transform((s) => s === "true")
          .optional(),
        cursor: z.string().max(1000).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    return search(db, ai, q.q, {
      projectId: q.projectId,
      kind: q.kind,
      historical: q.historical,
      cursor: q.cursor,
      limit: q.limit,
    });
  });
  app.post("/api/v1/messages", async (req, reply) => {
    const result = await postMessage(db, MessageInput.parse(req.body));
    return reply.code(result.replay ? 200 : 202).send(
      camel({
        conversationId: result.message.conversation_id,
        messageId: result.message.id,
        sourceId: result.source?.id ?? null,
        jobId: result.job?.id ?? null,
        replay: result.replay,
      }),
    );
  });
  app.get("/api/v1/messages/:id", async (req) => {
    const m = await one(
      db,
      `SELECT m.*,s.id AS source_id,s.kind AS source_kind FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN sources s ON s.message_id=m.id WHERE m.id=$1 AND m.role='user' AND c.state<>'deleting'`,
      [id(req)],
    );
    if (!m) fail(404, "NOT_FOUND", "Message not found.");
    const job = await one(
      db,
      "SELECT id,status,blocked_reason,error_code FROM processing_jobs WHERE dedupe_key=$1",
      [`converse:${m.id}`],
    );
    const turn = job
      ? await one(
          db,
          "SELECT id,status,message_kind,reply,actions,created_at,undo IS NOT NULL AS can_undo FROM agent_turns WHERE job_id=$1",
          [job.id],
        )
      : null;
    const status = !job
      ? "done"
      : job.status === "succeeded"
        ? "done"
        : job.status === "running"
          ? "working"
          : job.status === "retry_wait"
            ? job.blocked_reason
              ? "blocked"
              : "retrying"
            : job.status === "pending"
              ? job.blocked_reason
                ? "blocked"
                : "queued"
              : "failed";
    return camel({
      id: m.id,
      conversationId: m.conversation_id,
      content: m.content,
      createdAt: m.created_at,
      sourceId: m.source_id,
      kind: m.source_kind,
      status,
      blockedReason: job?.blocked_reason ?? null,
      errorCode: job?.error_code ?? null,
      turn: turn
        ? {
            id: turn.id,
            status: turn.status,
            kind: turn.message_kind,
            reply: turn.reply,
            actions: turn.actions,
            createdAt: turn.created_at,
            canUndo: turn.status === "completed" && turn.can_undo,
          }
        : null,
    });
  });
  app.post("/api/v1/turns/:id/undo", async (req) => undoTurn(db, id(req)));
  app.post("/api/v1/messages/:id/retry", async (req, reply) => {
    await db.transaction(async (tx) => {
      const job = await one(
        tx,
        "SELECT * FROM processing_jobs WHERE dedupe_key=$1 AND status IN('failed','cancelled') FOR UPDATE",
        [`converse:${id(req)}`],
      );
      if (!job)
        fail(409, "NOT_FAILED", "This message is not waiting for a retry.");
      await tx.query(
        `UPDATE processing_jobs SET status='pending',attempts=0,error_code=NULL,run_after=now(),blocked_reason=NULL,updated_at=now() WHERE id=$1`,
        [job.id],
      );
      await tx.query(
        `INSERT INTO audit_events(kind,reference_id,reason) VALUES('manual_retry',$1,'User requested a new bounded attempt budget')`,
        [job.id],
      );
    });
    return reply.code(202).send({ status: "queued" });
  });
  app.get("/api/v1/jobs/:id", async (req) => {
    const job = await one(
      db,
      "SELECT id,kind,status,attempts,max_attempts,error_code,blocked_reason,run_after FROM processing_jobs WHERE id=$1",
      [id(req)],
    );
    if (!job) fail(404, "NOT_FOUND", "Job not found.");
    return camel(job);
  });
  app.post("/api/v1/exports", async (req, reply) => {
    const body = z.strictObject({ includeAudio: z.boolean() }).parse(req.body),
      job = await db.transaction(async (tx) => {
        const j = await enqueue(
          tx,
          "export",
          `export:${randomUUID()}`,
          null,
          body,
        );
        await tx.query(
          `INSERT INTO exports(job_id,expires_at) VALUES($1,now()+interval '24 hours')`,
          [j.id],
        );
        return j;
      });
    return reply.code(202).send({ jobId: job.id });
  });
  app.get("/api/v1/exports/:id/download", async (req, reply) => {
    if ((await one(db, "SELECT maintenance FROM app_settings"))?.maintenance)
      fail(503, "MAINTENANCE", "Backup in progress.");
    const e = await one(
      db,
      "SELECT * FROM exports WHERE job_id=$1 AND expires_at>now() AND invalidated_at IS NULL",
      [id(req)],
    );
    if (!e?.storage_key)
      fail(404, "NOT_READY", "This export is not ready or has expired.");
    const file = await openPrivate(c, e.storage_key);
    return reply
      .header("Content-Type", "application/zip")
      .header(
        "Content-Disposition",
        'attachment; filename="secondbrain-export.zip"',
      )
      .send(file.createReadStream());
  });
  app.get("/api/v1/operations", async () => {
    const disk = await statfs(c.DATA_DIR).catch(() => null);
    return camel({
      jobs: (
        await db.query(
          "SELECT kind,status,count(*)::int AS count,min(created_at) AS oldest FROM processing_jobs GROUP BY kind,status",
        )
      ).rows,
      backups: (
        await db.query(
          "SELECT * FROM backup_runs ORDER BY created_at DESC LIMIT 10",
        )
      ).rows,
      processing: await one(
        db,
        `SELECT count(*) FILTER(WHERE status='running' AND lease_until<=now())::int AS expired_leases,extract(epoch FROM now()-min(created_at) FILTER(WHERE status IN('pending','retry_wait','running')))::int AS oldest_pending_seconds FROM processing_jobs`,
      ),
      failures: (
        await db.query(
          `SELECT id,kind,error_code,attempts,updated_at FROM processing_jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT 10`,
        )
      ).rows,
      vectors: await one(
        db,
        `SELECT (SELECT active_embedding_model FROM app_settings) AS model,count(*)::int AS total_chunks,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM embeddings v WHERE v.model=(SELECT active_embedding_model FROM app_settings) AND v.embedding IS NOT NULL AND v.input_sha256=l.input_sha256 AND v.chunk_index=l.chunk_index AND (v.source_id=l.source_id OR (v.item_id=l.item_id AND v.item_revision=l.item_revision))))::int AS indexed_chunks FROM embeddings l WHERE l.model='lexical-v1'`,
      ),
      usage: await one(
        db,
        `SELECT count(*)::int AS requests,coalesce(sum((call->>'inputTokens')::bigint),0)::text AS input_tokens,coalesce(sum((call->>'outputTokens')::bigint),0)::text AS output_tokens,count(*) FILTER(WHERE call->>'totalTokens' IS NULL)::int AS requests_without_token_counts FROM processing_jobs j CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.provider_metadata,'[]'::jsonb)) attempt CROSS JOIN LATERAL jsonb_array_elements(attempt->'calls') call`,
      ),
      disk: disk
        ? {
            availableBytes: disk.bavail * disk.bsize,
            totalBytes: disk.blocks * disk.bsize,
            lowSpace:
              disk.bavail * disk.bsize < 1073741824 ||
              disk.bavail / Math.max(1, disk.blocks) < 0.1,
          }
        : null,
    });
  });
  return app;
}
