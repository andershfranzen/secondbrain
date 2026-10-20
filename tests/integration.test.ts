import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import argon2 from "argon2";
import { Queue, Worker } from "bullmq";
import { redisProxy } from "./helpers/redis-proxy.js";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  open,
  rename,
  readdir,
  utimes,
  stat,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, one } from "@secondbrain/database";
import { migrate } from "../packages/database/src/migrate.js";
import {
  config,
  randomUUID,
  hash,
  slice,
  assertEvidence,
  operationId,
} from "@secondbrain/shared";
import {
  FakeProvider,
  ProviderError,
  exec,
  type AgentRequest,
} from "@secondbrain/ai";
import { buildServer } from "../apps/api/src/server.js";
import {
  captureText,
  processJob,
  claimJob,
  withLease,
  search,
  initStorage,
  privatePath,
  captureAudio,
  retainAudio,
  recoverJobs,
  dispatchDueJobs,
  sweepFiles,
} from "@secondbrain/memory";
const url =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:integration-only@127.0.0.1:55432/secondbrain_test";
let db: Database,
  c: ReturnType<typeof config>,
  app: Awaited<ReturnType<typeof buildServer>>,
  dir: string;
const ai = new FakeProvider();
let cookies: Record<string, string> = {};
async function request(
  method: string,
  path: string,
  body?: Record<string, any>,
  headers: Record<string, string> = {},
) {
  const r = await app.inject({
    method: method as any,
    url: "/api/v1" + path,
    headers: {
      origin: "http://localhost:3000",
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
      "x-csrf-token": cookies.sb_csrf ?? "",
      ...headers,
    },
    ...(body !== undefined ? { payload: body } : {}),
  });
  for (const entry of r.cookies) cookies[entry.name] = entry.value;
  return {
    status: r.statusCode,
    body: r.body ? JSON.parse(r.body) : null,
    headers: r.headers,
    raw: r,
  };
}
async function login() {
  await request("GET", "/auth/csrf");
  const r = await request("POST", "/auth/login", {
    password: "integration-password",
  });
  expect(r.status).toBe(204);
}
async function drain(adapter = ai) {
  for (let i = 0; i < 60; i++) {
    const job = await one(
      db,
      `SELECT id FROM processing_jobs WHERE status IN('pending','retry_wait') AND run_after<=now() AND blocked_reason IS NULL ORDER BY created_at,id LIMIT 1`,
    );
    if (!job) return;
    await processJob(db, c, adapter, job.id);
  }
  throw new Error("job drain exceeded limit");
}
beforeAll(async () => {
  const base = new URL(url),
    name = base.pathname.slice(1);
  if (!/test/.test(name))
    throw new Error(
      "TEST_DATABASE_URL must reference a dedicated test database",
    );
  base.pathname = "/postgres";
  const admin = new Database(base.toString());
  if (!(await one(admin, "SELECT 1 FROM pg_database WHERE datname=$1", [name])))
    await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  await admin.close();
  await migrate(url);
  dir = await mkdtemp(join(tmpdir(), "secondbrain-test-"));
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = "a-test-session-secret-with-over-32-bytes";
  process.env.AI_PROVIDER = "fake";
  process.env.DATA_DIR = dir;
  process.env.ERASURE_MANIFEST_PATH = join(
    dir,
    "erasure-ledger",
    "manifest.jsonl",
  );
  process.env.AUTH_PASSWORD_HASH = await argon2.hash("integration-password");
  process.env.LOG_LEVEL = "silent";
  c = config();
  db = new Database(url);
  app = await buildServer(c, db, ai);
});
beforeEach(async () => {
  await app.close();
  app = await buildServer(c, db, ai);
  const tables = (
    await db.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'`,
    )
  ).rows;
  await db.query(
    "TRUNCATE " + tables.map((t) => `"${t.tablename}"`).join(",") + " CASCADE",
  );
  await db.query(
    "INSERT INTO app_settings(singleton,cloud_consent_at) VALUES(true,now())",
  );
  cookies = {};
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("private capture and sessions", () => {
  it("migrates queued legacy recall turns into question/answer order without ordinal collisions", async () => {
    const sql = await readFile(
      new URL(
        "../packages/database/migrations/0004_recall_turn_order.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.transaction(async (tx) => {
      await tx.query(`CREATE TEMP TABLE conversations(id text PRIMARY KEY,mode text) ON COMMIT DROP;
        CREATE TEMP TABLE messages(id text PRIMARY KEY,conversation_id text,ordinal int,role text,origin_key text,UNIQUE(conversation_id,ordinal)) ON COMMIT DROP;
        CREATE TEMP TABLE recall_requests(job_id text,question_message_id text) ON COMMIT DROP;
        INSERT INTO conversations VALUES('chat','recall'),('dump','text');
        INSERT INTO messages VALUES('q1','chat',0,'user',NULL),('q2','chat',1,'user',NULL),('a2','chat',2,'assistant','answer:job2'),('a1','chat',3,'assistant','answer:job1'),('original','dump',0,'user',NULL);
        INSERT INTO recall_requests VALUES('job1','q1'),('job2','q2');`);
      await tx.query(
        sql.replace(/^BEGIN;\s*$/gm, "").replace(/^COMMIT;\s*$/gm, ""),
      );
      expect(
        (
          await tx.query(
            "SELECT id,ordinal FROM messages WHERE conversation_id='chat' ORDER BY ordinal",
          )
        ).rows,
      ).toEqual([
        { id: "q1", ordinal: 0 },
        { id: "a1", ordinal: 1 },
        { id: "q2", ordinal: 2 },
        { id: "a2", ordinal: 3 },
      ]);
      expect(
        (await one(tx, "SELECT ordinal FROM messages WHERE id='original'"))!
          .ordinal,
      ).toBe(0);
    });
  });
  it("rolls back failed migrations and resumes without replaying committed work", async () => {
    const schema = `migration_${randomUUID().replaceAll("-", "")}`;
    const folder = await mkdtemp(join(tmpdir(), "secondbrain-migration-"));
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    await db.query(`CREATE SCHEMA ${schema}`);
    const scoped = new Database(scopedUrl.toString());
    try {
      await writeFile(
        join(folder, "0001.sql"),
        "BEGIN;\nCREATE TABLE durable(id int PRIMARY KEY);\nINSERT INTO durable VALUES(1);\nCOMMIT;\n",
      );
      await writeFile(
        join(folder, "0002.sql"),
        "BEGIN;\nCREATE TABLE partial(id int);\nSELECT 1/0;\nCOMMIT;\n",
      );
      await expect(migrate(scopedUrl.toString(), folder)).rejects.toThrow(
        "division by zero",
      );
      expect((await scoped.query("SELECT * FROM durable")).rows).toEqual([
        { id: 1 },
      ]);
      expect(
        (await one(scoped, "SELECT to_regclass('partial') AS relation"))!
          .relation,
      ).toBeNull();
      expect(
        (await scoped.query("SELECT name FROM schema_migrations")).rows,
      ).toEqual([{ name: "0001.sql" }]);
      await writeFile(
        join(folder, "0002.sql"),
        "CREATE TABLE partial(id int);",
      );
      await migrate(scopedUrl.toString(), folder);
      await migrate(scopedUrl.toString(), folder);
      expect(
        (await scoped.query("SELECT name FROM schema_migrations")).rowCount,
      ).toBe(2);
      await writeFile(join(folder, "0001.sql"), "SELECT 1;");
      await expect(migrate(scopedUrl.toString(), folder)).rejects.toThrow(
        "Migration checksum changed",
      );
    } finally {
      await scoped.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await rm(folder, { recursive: true, force: true });
    }
  });
  it("protects JSON, source, audio, exports and SSE routes", async () => {
    for (const path of [
      "/me",
      "/sources/" + randomUUID(),
      "/attachments/" + randomUUID() + "/content",
      "/exports/" + randomUUID() + "/download",
      "/recall/" + randomUUID() + "/events",
    ])
      expect((await request("GET", path)).status).toBe(401);
  });
  it("rejects cross-origin mutations and missing prelogin/session CSRF", async () => {
    expect(
      (
        await request("POST", "/auth/login", {
          password: "integration-password",
        })
      ).status,
    ).toBe(403);
    await login();
    expect(
      (
        await request(
          "POST",
          "/captures/text",
          { clientCaptureId: randomUUID(), text: "Hi" },
          { origin: "https://attacker.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "POST",
          "/captures/text",
          { clientCaptureId: randomUUID(), text: "Hi" },
          { "x-csrf-token": "" },
        )
      ).status,
    ).toBe(403);
  });
  it("saves originals and lexical chunks atomically, replays identical IDs, rejects different content", async () => {
    await login();
    const body = {
      clientCaptureId: randomUUID(),
      text: "🌱 Maybe I should build a browser MMO.",
    };
    const first = await request("POST", "/captures/text", body),
      second = await request("POST", "/captures/text", body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
    expect(
      (await request("POST", "/captures/text", { ...body, text: "Other" }))
        .status,
    ).toBe(409);
    expect((await db.query("SELECT * FROM sources")).rows).toHaveLength(1);
    expect((await db.query("SELECT * FROM processing_jobs")).rows).toHaveLength(
      1,
    );
    const found = await search(db, ai, "browser MMO", { semantic: false });
    expect(found.items[0]?.content).toBe(body.text);
  });
  it("handles concurrent captures without duplicates", async () => {
    const input = {
      clientCaptureId: randomUUID(),
      text: "I will verify Forgejo.",
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => captureText(db, input)),
    );
    expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
    expect((await db.query("SELECT * FROM sources")).rows).toHaveLength(1);
  });
  it("preserves captures during Redis loss and rebuilds erased transport jobs from the ledger", async () => {
    const redis = new URL(
      process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0",
    );
    const proxy = await redisProxy(redis);
    const connection = {
      host: "127.0.0.1",
      port: proxy.port,
      db: Number(redis.pathname.slice(1) || 0),
      username: redis.username ? decodeURIComponent(redis.username) : undefined,
      password: redis.password ? decodeURIComponent(redis.password) : undefined,
      retryStrategy: () => 50,
    };
    const name = `secondbrain-outage-${randomUUID()}`;
    const queue = new Queue(name, {
      connection: { ...connection, maxRetriesPerRequest: 1 },
    });
    queue.on("error", () => {});
    let worker: Worker | undefined;
    try {
      await queue.waitUntilReady();
      await proxy.stop();
      await login();
      const original = "I will verify Forgejo on Home Server.";
      const saved = await request("POST", "/captures/text", {
        clientCaptureId: randomUUID(),
        text: original,
      });
      expect(saved.status).toBe(201);
      const conversationId = saved.body.conversation.id;
      await expect(dispatchDueJobs(db, queue)).rejects.toThrow();
      const pending = (await one(
        db,
        "SELECT * FROM processing_jobs WHERE conversation_id=$1",
        [conversationId],
      ))!;
      expect(pending).toMatchObject({ status: "pending", attempts: 0 });
      expect(
        (await search(db, ai, "Forgejo", { semantic: false })).items.some(
          (item) => item.content === original,
        ),
      ).toBe(true);
      await proxy.start();
      await expect
        .poll(
          async () => {
            try {
              await queue.getJob(pending.id);
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 5000 },
        )
        .toBe(true);
      await dispatchDueJobs(db, queue);
      expect(await queue.getJob(pending.id)).toBeDefined();
      // Lose all delivery state for this unique test-owned queue, never FLUSHDB.
      await queue.obliterate({ force: true });
      expect(await queue.getJob(pending.id)).toBeUndefined();
      expect(
        (
          await one(db, "SELECT status FROM processing_jobs WHERE id=$1", [
            pending.id,
          ])
        )?.status,
      ).toBe("pending");
      worker = new Worker(name, (job) => processJob(db, c, ai, job.id!), {
        connection: { ...connection, maxRetriesPerRequest: null },
      });
      worker.on("error", () => {});
      await worker.waitUntilReady();
      await expect
        .poll(
          async () => {
            await dispatchDueJobs(db, queue);
            const state = (
              await one(db, "SELECT state FROM conversations WHERE id=$1", [
                conversationId,
              ])
            )?.state;
            const open = (await one(
              db,
              "SELECT count(*)::int AS n FROM processing_jobs WHERE status<>'succeeded'",
            ))!.n;
            return `${state}:${open}`;
          },
          { timeout: 10000, interval: 100 },
        )
        .toBe("ready:0");
      expect(
        (await one(db, "SELECT count(*)::int AS count FROM sources"))?.count,
      ).toBe(1);
      expect(
        (await one(db, "SELECT count(*)::int AS count FROM tasks"))?.count,
      ).toBe(1);
      const jobs = (
        await db.query("SELECT kind,status,attempts FROM processing_jobs")
      ).rows;
      expect(
        jobs.every((job) => job.status === "succeeded" && job.attempts === 1),
      ).toBe(true);
      expect(jobs.filter((job) => job.kind === "converse")).toHaveLength(1);
      expect((await one(db, "SELECT content FROM sources"))?.content).toBe(
        original,
      );
    } finally {
      await proxy.start();
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await proxy.stop();
    }
  });
  it("leaves capture searchable and jobs unclaimed without consent", async () => {
    await db.query("UPDATE app_settings SET cloud_consent_at=NULL");
    const saved = await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "Remember the Forgejo setup.",
    });
    expect(await claimJob(db, saved.job!.id, ai)).toBeUndefined();
    const job = (await one(db, "SELECT * FROM processing_jobs WHERE id=$1", [
      saved.job!.id,
    ]))!;
    expect(job.attempts).toBe(0);
    expect(job.blocked_reason).toBe("CONSENT_REQUIRED");
    expect(
      (await search(db, ai, "Forgejo", { semantic: false })).items,
    ).toHaveLength(1);
  });
  it("changes password atomically and revokes every old session", async () => {
    await login();
    const changed = await request("POST", "/auth/password", {
      currentPassword: "integration-password",
      newPassword: "replacement-password",
    });
    expect(changed.status).toBe(204);
    expect((await db.query("SELECT * FROM sessions")).rows).toHaveLength(0);
    await request("GET", "/auth/csrf");
    expect(
      (
        await request("POST", "/auth/login", {
          password: "replacement-password",
        })
      ).status,
    ).toBe(204);
    await rm(join(dir, "secrets", "password.hash"));
  });
});

describe("memory and durable processing", () => {
  it("manually retries only failed embeddings without repeating the agent turn", async () => {
    class Counted extends FakeProvider {
      agentCalls = 0;
      embeddingCalls = 0;
      failEmbedding = false;
      override async runAgent<T>(request: AgentRequest<T>) {
        this.agentCalls++;
        return super.runAgent(request);
      }
      override async embed(texts: string[]) {
        this.embeddingCalls++;
        if (this.failEmbedding)
          throw new ProviderError("INVALID_EMBEDDING", false);
        return super.embed(texts);
      }
    }
    const adapter = new Counted();
    const saved = await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "I will verify Forgejo on Home Server.",
    });
    await processJob(db, c, adapter, saved.job!.id);
    const embed = (await one(
      db,
      "SELECT id FROM processing_jobs WHERE kind='embed' AND conversation_id=$1",
      [saved.conversation.id],
    ))!;
    adapter.failEmbedding = true;
    await processJob(db, c, adapter, embed.id);
    expect(
      (await one(db, "SELECT status FROM processing_jobs WHERE id=$1", [
        embed.id,
      ]))!.status,
    ).toBe("failed");
    expect(
      (await search(db, adapter, "Forgejo", { semantic: false })).items.length,
    ).toBeGreaterThan(0);
    await login();
    expect(
      (await request("POST", `/conversations/${saved.conversation.id}/retry`))
        .status,
    ).toBe(202);
    adapter.failEmbedding = false;
    await processJob(db, c, adapter, embed.id);
    expect(adapter.agentCalls).toBe(1);
    expect(adapter.embeddingCalls).toBe(2);
    expect(
      (
        await db.query(
          "SELECT kind,status,attempts FROM processing_jobs ORDER BY created_at,id",
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        { kind: "converse", status: "succeeded", attempts: 1 },
        { kind: "embed", status: "succeeded", attempts: 1 },
      ]),
    );
    expect((await db.query("SELECT * FROM tasks")).rows).toHaveLength(1);
    expect((await db.query("SELECT * FROM sources")).rows).toHaveLength(1);
    expect(
      (await db.query("SELECT * FROM audit_events WHERE kind='manual_retry'"))
        .rows,
    ).toHaveLength(1);
    expect(
      (await one(db, "SELECT state FROM conversations WHERE id=$1", [
        saved.conversation.id,
      ]))!.state,
    ).toBe("ready");
  });
  it("processes a commitment and uncertain idea, keeps valid provenance, and indexes vectors", async () => {
    await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "I will verify Forgejo.",
    });
    await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "Maybe I should buy another server.",
    });
    await drain();
    const tasks = (
      await db.query("SELECT * FROM item_records WHERE kind='task'")
    ).rows;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.due_date).toBeNull();
    expect(tasks[0]!.disposition).toBe("commitment");
    expect((await db.query("SELECT * FROM ideas")).rows).toHaveLength(1);
    expect((await db.query("SELECT * FROM item_sources")).rows).toHaveLength(2);
    expect(
      (await db.query("SELECT * FROM embeddings WHERE embedding IS NOT NULL"))
        .rows.length,
    ).toBeGreaterThan(0);
  });
  it("does not let two workers claim or late workers apply the same lease", async () => {
    const saved = await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "One job.",
    });
    const claims = await Promise.all([
      claimJob(db, saved.job!.id, ai),
      claimJob(db, saved.job!.id, ai),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    await db.query(
      `UPDATE processing_jobs SET status='retry_wait',lease_token=NULL,lease_until=NULL WHERE id=$1`,
      [old.id],
    );
    const next = await claimJob(db, old.id, ai);
    expect(next!.lease_token).not.toBe(old.lease_token);
    await expect(
      withLease(db, old, async (tx) => tx.query("DELETE FROM sources")),
    ).rejects.toThrow("LEASE_LOST");
    expect((await db.query("SELECT * FROM sources")).rows).toHaveLength(1);
  });
  it("retries transient provider failures without losing originals", async () => {
    class Unavailable extends FakeProvider {
      override async runAgent(): Promise<any> {
        throw new Error("No network");
      }
    }
    const saved = await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "Never lose this.",
    });
    await processJob(db, c, new Unavailable(), saved.job!.id);
    const job = (await one(db, "SELECT * FROM processing_jobs WHERE id=$1", [
      saved.job!.id,
    ]))!;
    expect(job.status).toBe("retry_wait");
    expect(job.attempts).toBe(1);
    expect(job.provider_metadata).toMatchObject([{ attempt: 1, calls: [] }]);
    expect(
      (await db.query("SELECT content FROM sources")).rows[0]!.content,
    ).toBe("Never lose this.");
  });
  it("requires revisions and rejects stale edits; corrections suppress obsolete raw source recall", async () => {
    await login();
    const created = await request("POST", "/items", {
      kind: "memory",
      title: "Database preference",
      content: "I prefer SQLite for Second Brain.",
    });
    expect(created.status).toBe(201);
    const item = created.body;
    expect(
      (await request("PATCH", `/items/${item.id}`, { title: "Other" })).status,
    ).toBe(428);
    expect(
      (
        await request(
          "PATCH",
          `/items/${item.id}`,
          { title: "Other" },
          { "If-Match": '"99"' },
        )
      ).status,
    ).toBe(412);
    const changed = await request(
      "POST",
      `/items/${item.id}/corrections`,
      {
        assertion: "I prefer PostgreSQL for Second Brain.",
        reason: "Changed my mind.",
      },
      { "If-Match": '"1"' },
    );
    expect(changed.status).toBe(201);
    expect(
      (await search(db, ai, "SQLite", { semantic: false })).items,
    ).toHaveLength(0);
    expect(
      (await search(db, ai, "SQLite", { semantic: false, historical: true }))
        .items,
    ).toHaveLength(1);
    expect(
      (await search(db, ai, "PostgreSQL", { semantic: false })).items,
    ).toHaveLength(1);
  });
});

describe("recall, deletion and export", () => {
  it("deletes original and all derived knowledge, invalidating recall immediately", async () => {
    const saved = await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "Forgejo has a documented backup.",
    });
    await drain();
    await login();
    const r = await request("POST", "/messages", {
      clientMessageId: randomUUID(),
      text: "Find Forgejo backup",
    });
    await drain();
    expect(
      (await request("GET", `/messages/${r.body.messageId}`)).body.turn.reply
        .claims,
    ).toHaveLength(1);
    const removed = await request(
      "DELETE",
      `/conversations/${saved.conversation.id}`,
      { confirm: true },
    );
    expect(removed.status).toBe(202);
    expect(
      (await search(db, ai, "Forgejo", { semantic: false })).items,
    ).toHaveLength(0);
    expect(
      (await request("GET", `/messages/${r.body.messageId}`)).body.turn.status,
    ).toBe("invalidated");
    await drain();
    // Only the question remains: an original from a conversation nobody erased.
    expect((await db.query("SELECT kind,content FROM sources")).rows).toEqual([
      { kind: "question", content: "Find Forgejo backup" },
    ]);
    expect((await db.query("SELECT * FROM knowledge_items")).rows).toHaveLength(
      0,
    );
    expect((await db.query("SELECT * FROM memory_events")).rows).toHaveLength(
      0,
    );
    expect(
      (
        await one(db, "SELECT * FROM erasures WHERE conversation_id=$1", [
          saved.conversation.id,
        ])
      )?.completed_at,
    ).not.toBeNull();
  });
  it("creates a portable private archive with no session or provider secret records", async () => {
    await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "An exportable thought.",
    });
    await drain();
    await login();
    const created = await request("POST", "/exports", { includeAudio: false });
    expect(created.status).toBe(202);
    await drain();
    const e = (await one(db, "SELECT * FROM exports WHERE job_id=$1", [
      created.body.jobId,
    ]))!;
    expect(e.storage_key).toBeTruthy();
    const buffer = await readFile(privatePath(c, e.storage_key));
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    expect(
      (await request("GET", `/jobs/${created.body.jobId}`)).body.status,
    ).toBe("succeeded");
  });
});

function wav() {
  const samples = 16000,
    buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}
describe("original audio durability", () => {
  it.each([
    { extension: "webm", codec: "libopus", mime: "audio/webm" },
    { extension: "mp4", codec: "aac", mime: "audio/mp4" },
  ])(
    "accepts a real $extension recording with a server-generated storage key",
    async ({ extension, codec, mime }) => {
      const root = await mkdtemp(join(dir, "encoded-audio-"));
      try {
        const input = join(root, "original.wav"),
          output = join(root, `encoded.${extension}`);
        await writeFile(input, wav());
        await exec(
          "ffmpeg",
          ["-nostdin", "-v", "error", "-i", input, "-c:a", codec, output],
          { timeout: 10000 },
        );
        const bytes = await readFile(output);
        const saved = await captureAudio(
          db,
          c,
          Readable.from(bytes),
          randomUUID(),
          mime,
        );
        const attachment = (await one(
          db,
          "SELECT * FROM attachments WHERE conversation_id=$1",
          [saved.conversation.id],
        ))!;
        expect(attachment.storage_key).toMatch(
          new RegExp(`^audio/[0-9a-f-]{36}\\.${extension}$`),
        );
        expect(attachment.media_type).toBe(mime);
        expect(await readFile(privatePath(c, attachment.storage_key))).toEqual(
          bytes,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("rejects audio beyond the configured duration without storing a capture", async () => {
    await expect(
      captureAudio(
        db,
        { ...c, MAX_RECORDING_SECONDS: 0.5 },
        Readable.from(wav()),
        randomUUID(),
        "audio/wav",
      ),
    ).rejects.toThrow("no longer than");
    expect((await db.query("SELECT * FROM attachments")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM conversations")).rows).toHaveLength(
      0,
    );
    expect((await db.query("SELECT * FROM upload_leases")).rows).toHaveLength(
      0,
    );
  });

  it.each(["disk-full", "rename-failure"])(
    "never accepts audio after %s and removes staging files",
    async (failure) => {
      const path = await mkdtemp(join(dir, "audio-failure-"));
      const local = { ...c, DATA_DIR: path };
      const io = {
        async open(...args: Parameters<typeof open>) {
          const file = await open(...args);
          if (failure === "disk-full" && String(args[0]).endsWith(".part"))
            file.writeFile = async () => {
              throw Object.assign(new Error("synthetic disk full"), {
                code: "ENOSPC",
              });
            };
          return file;
        },
        async rename(...args: Parameters<typeof rename>) {
          if (failure === "rename-failure")
            throw Object.assign(new Error("synthetic rename failure"), {
              code: "EIO",
            });
          await rename(...args);
        },
      };
      try {
        await expect(
          captureAudio(
            db,
            local,
            Readable.from(wav()),
            randomUUID(),
            "audio/wav",
            undefined,
            io,
          ),
        ).rejects.toThrow();
        expect(
          (await db.query("SELECT * FROM conversations")).rows,
        ).toHaveLength(0);
        expect((await db.query("SELECT * FROM attachments")).rows).toHaveLength(
          0,
        );
        expect(
          (await db.query("SELECT * FROM upload_leases")).rows,
        ).toHaveLength(0);
        expect(await readdir(join(path, "staging"))).toEqual([]);
        expect(await readdir(join(path, "audio"))).toEqual([]);
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    },
  );
  it("sweeps a rolled-back audio orphan while preserving old referenced and actively leased files", async () => {
    const path = await mkdtemp(join(dir, "audio-rollback-"));
    const local = { ...c, DATA_DIR: path };
    try {
      await captureAudio(
        db,
        local,
        Readable.from(wav()),
        randomUUID(),
        "audio/wav",
      );
      const existing = (await one(db, "SELECT * FROM attachments"))!;
      const rolledBack = Object.create(db) as Database;
      rolledBack.transaction = (fn) =>
        db.transaction(async (tx) => {
          await fn(tx);
          throw new Error("synthetic commit failure");
        });
      await expect(
        captureAudio(
          rolledBack,
          local,
          Readable.from(wav()),
          randomUUID(),
          "audio/wav",
        ),
      ).rejects.toThrow("synthetic commit failure");
      expect((await db.query("SELECT * FROM attachments")).rows).toHaveLength(
        1,
      );
      expect((await db.query("SELECT * FROM conversations")).rows).toHaveLength(
        1,
      );
      const orphan = (await readdir(join(path, "audio"))).find(
        (name) => `audio/${name}` !== existing.storage_key,
      )!;
      expect(orphan).toBeDefined();
      const activeKey = `staging/${randomUUID()}.part`,
        expiredKey = `staging/${randomUUID()}.part`;
      await writeFile(privatePath(local, activeKey), "active synthetic upload");
      await writeFile(
        privatePath(local, expiredKey),
        "abandoned synthetic upload",
      );
      await db.query(
        "INSERT INTO upload_leases(storage_key,expires_at) VALUES($1,now()+interval '1 hour')",
        [activeKey],
      );
      const old = new Date(Date.now() - 2 * 86400000);
      for (const key of [
        existing.storage_key,
        `audio/${orphan}`,
        activeKey,
        expiredKey,
      ])
        await utimes(privatePath(local, key), old, old);
      await sweepFiles(db, local);
      expect(await readdir(join(path, "audio"))).toEqual([
        existing.storage_key.split("/")[1],
      ]);
      expect(await readdir(join(path, "staging"))).toEqual([
        activeKey.split("/")[1],
      ]);
      expect((await stat(privatePath(local, existing.storage_key))).size).toBe(
        wav().length,
      );
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("validates real media, replays upload IDs, transcribes and retains the transcript after audio expires", async () => {
    const bytes = wav(),
      client = randomUUID(),
      first = await captureAudio(
        db,
        c,
        Readable.from(bytes),
        client,
        "audio/wav",
      );
    const replay = await captureAudio(
      db,
      c,
      Readable.from(bytes),
      client,
      "audio/wav",
    );
    expect(replay.conversation.id).toBe(first.conversation.id);
    expect((await db.query("SELECT * FROM attachments")).rows).toHaveLength(1);
    await db.query(
      "UPDATE attachments SET retain_until=now()-interval '1 day'",
    );
    await db.transaction((tx) => retainAudio(tx, c));
    expect((await one(db, "SELECT state FROM attachments"))!.state).toBe(
      "available",
    );
    await drain();
    await db.transaction((tx) => retainAudio(tx, c));
    expect((await one(db, "SELECT state FROM attachments"))!.state).toBe(
      "purged",
    );
    expect(
      (await db.query("SELECT content FROM sources")).rows[0]!.content,
    ).toContain("synthetic voice capture");
  });
  it("rejects corrupt audio, mismatched media, truncated streams and size overflow without committing captures", async () => {
    await expect(
      captureAudio(
        db,
        c,
        Readable.from(Buffer.from("not audio")),
        randomUUID(),
        "audio/wav",
      ),
    ).rejects.toThrow();
    await expect(
      captureAudio(db, c, Readable.from(wav()), randomUUID(), "audio/mpeg"),
    ).rejects.toThrow();
    const stream = Readable.from(wav()) as Readable & { truncated: boolean };
    stream.truncated = true;
    await expect(
      captureAudio(db, c, stream, randomUUID(), "audio/wav"),
    ).rejects.toThrow("upload limit");
    await expect(
      captureAudio(
        db,
        { ...c, MAX_UPLOAD_BYTES: 100 },
        Readable.from(wav()),
        randomUUID(),
        "audio/wav",
      ),
    ).rejects.toThrow("too large");
    expect((await db.query("SELECT * FROM conversations")).rows).toHaveLength(
      0,
    );
    expect((await db.query("SELECT * FROM upload_leases")).rows).toHaveLength(
      0,
    );
  });
});

describe("independent manual provenance", () => {
  it("keeps individually supported project edits when another supporting capture is erased", async () => {
    await login();
    const original = await request("POST", "/items", {
      kind: "project",
      title: "Home server",
      content: "The initial deployment plan.",
    });
    const source = (await one(
      db,
      "SELECT m.conversation_id FROM item_sources i JOIN sources s ON s.id=i.source_id JOIN messages m ON m.id=s.message_id WHERE i.item_id=$1",
      [original.body.id],
    ))!;
    expect(
      (
        await request(
          "PATCH",
          `/items/${original.body.id}`,
          {
            title: "Home lab",
            currentState: "Forgejo is ready.",
            nextStep: "Verify the restore.",
          },
          { "If-Match": '"1"' },
        )
      ).status,
    ).toBe(200);
    await request("DELETE", `/conversations/${source.conversation_id}`, {
      confirm: true,
    });
    await drain();
    const retained = await request("GET", `/items/${original.body.id}`);
    expect(retained.status).toBe(200);
    expect(retained.body.title).toBe("Home lab");
    expect(retained.body.currentState).toBe("Forgejo is ready.");
    expect(retained.body.nextStep).toBe("Verify the restore.");
    expect(JSON.stringify(retained.body)).not.toContain(
      "initial deployment plan",
    );
  });
});

describe("audio HTTP delivery", () => {
  it("rejects a path-shaped multipart filename before creating an original", async () => {
    await login();
    const boundary = `sb-unsafe-name-${randomUUID()}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/captures/audio",
      headers: {
        origin: "http://localhost:3000",
        cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
        "x-csrf-token": cookies.sb_csrf!,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="clientCaptureId"\r\n\r\n${randomUUID()}\r\n--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="../../outside.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
        ),
        wav(),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_AUDIO_FILENAME");
    expect((await db.query("SELECT * FROM conversations")).rows).toHaveLength(
      0,
    );
    expect((await db.query("SELECT * FROM upload_leases")).rows).toHaveLength(
      0,
    );
  });

  it("streams multipart upload and authenticated byte ranges", async () => {
    await login();
    const boundary = "sb-test-" + randomUUID(),
      body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="clientCaptureId"\r\n\r\n${randomUUID()}\r\n--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
        ),
        wav(),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/captures/audio",
      headers: {
        origin: "http://localhost:3000",
        cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
        "x-csrf-token": cookies.sb_csrf!,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    const attachment = (await one(db, "SELECT id FROM attachments"))!;
    const ranged = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachment.id}/content`,
      headers: {
        cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
        range: "bytes=0-3",
      },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.toString()).toBe("RIFF");
    expect(ranged.headers["content-range"]).toMatch(/^bytes 0-3\//);
  });
});

describe("contextual recall and current retrieval", () => {
  it("blocks unsupported subscription capabilities without attempts or paid fallback", async () => {
    const saved = await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "Subscription mode keeps my original.",
    });
    await drain();
    const embed = (await one(
      db,
      "SELECT id FROM processing_jobs WHERE kind='embed' LIMIT 1",
    ))!.id;
    await db.query(
      "UPDATE processing_jobs SET status='pending',attempts=0 WHERE id=$1",
      [embed],
    );
    const subscribed = Object.assign(new FakeProvider(), {
      capabilities: { embeddings: false, transcription: false },
    });
    expect(await claimJob(db, embed, subscribed)).toBeUndefined();
    expect(
      await one(
        db,
        "SELECT attempts,blocked_reason FROM processing_jobs WHERE id=$1",
        [embed],
      ),
    ).toEqual({ attempts: 0, blocked_reason: "EMBEDDINGS_NOT_CONFIGURED" });
    await recoverJobs(db, subscribed);
    expect(
      (await one(db, "SELECT blocked_reason FROM processing_jobs WHERE id=$1", [
        embed,
      ]))!.blocked_reason,
    ).toBe("EMBEDDINGS_NOT_CONFIGURED");
    expect(
      (await search(db, subscribed, "Subscription mode", { semantic: true }))
        .items.length,
    ).toBeGreaterThan(0);
    await recoverJobs(db, ai);
    expect(
      (await one(db, "SELECT blocked_reason FROM processing_jobs WHERE id=$1", [
        embed,
      ]))!.blocked_reason,
    ).toBeNull();
    expect(saved.conversation.id).toBeDefined();
  });
  it("supports query-bound search cursors without duplicates", async () => {
    await db.query("UPDATE app_settings SET cloud_consent_at=NULL");
    for (let i = 0; i < 8; i++)
      await captureText(db, {
        clientCaptureId: randomUUID(),
        text: `paginationmarker Entry ${i}.`,
      });
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await search(db, ai, "paginationmarker", {
        semantic: false,
        limit: 3,
        cursor,
      });
      found.push(...page.items.map((s) => s.sourceId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toHaveLength(8);
    expect(new Set(found).size).toBe(8);
    const first = await search(db, ai, "paginationmarker", {
      semantic: false,
      limit: 1,
    });
    await expect(
      search(db, ai, "different", {
        semantic: false,
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow("cursor");
  });
  it("retrieves normalized aliases and current item revisions, honoring kind/project filters", async () => {
    await login();
    const project = (
      await request("POST", "/items", {
        kind: "project",
        title: "Home Server",
        content: "A self-hosting project.",
      })
    ).body;
    const aliased = await request(
      "PATCH",
      `/items/${project.id}`,
      { aliases: ["The Lab"] },
      { "If-Match": '"1"' },
    );
    expect(aliased.status).toBe(200);
    expect(
      (await one(
        db,
        "SELECT s.content FROM item_sources i JOIN sources s ON s.id=i.source_id WHERE i.item_id=$1 AND i.role='corrects'",
        [project.id],
      ))!.content,
    ).toContain('"aliases":["The Lab"]');
    const alias = await search(db, ai, "  THE   LAB ", {
      semantic: false,
      kind: "project",
      projectId: project.id,
    });
    expect(alias.items[0]?.itemId).toBe(project.id);
    expect(alias.items[0]?.itemRevision).toBe(2);
    const other = await search(db, ai, "The Lab", {
      semantic: false,
      kind: "task",
    });
    expect(other.items).toHaveLength(0);
    await request(
      "PATCH",
      `/items/${project.id}`,
      { title: "Home Infrastructure" },
      { "If-Match": '"2"' },
    );
    const updated = await search(db, ai, "Home Infrastructure", {
      semantic: false,
      kind: "project",
    });
    expect(updated.items[0]?.itemRevision).toBe(3);
    expect(updated.items[0]?.itemTitle).toBe("Home Infrastructure");
  });
  it("reports processing health and usage without including private captures", async () => {
    await login();
    await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "private-health-fixture",
    });
    await drain();
    const job = (await one(db, "SELECT id FROM processing_jobs LIMIT 1"))!.id;
    await db.query(
      "UPDATE processing_jobs SET provider_metadata=$2 WHERE id=$1",
      [
        job,
        JSON.stringify([
          {
            attempt: 1,
            calls: [
              { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
              { inputTokens: null, outputTokens: null, totalTokens: null },
            ],
          },
        ]),
      ],
    );
    const response = await request("GET", "/operations");
    expect(response.status).toBe(200);
    expect(response.body.usage).toMatchObject({
      requests: 2,
      inputTokens: "12",
      outputTokens: "3",
      requestsWithoutTokenCounts: 1,
    });
    expect(response.body.disk.availableBytes).toBeGreaterThan(0);
    expect(response.body.vectors.totalChunks).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain(
      "private-health-fixture",
    );
  });
});

describe("schema readiness", () => {
  it("requires the packaged migration names and checksums rather than a row count", async () => {
    const name = "0005_review_relationship_resolution.sql";
    const original = (await one(
      db,
      "SELECT * FROM schema_migrations WHERE name=$1",
      [name],
    ))!;
    const unknown = "9999_readiness_test_only.sql";
    expect(
      (await app.inject({ method: "GET", url: "/health/ready" })).statusCode,
    ).toBe(200);
    try {
      await db.query("DELETE FROM schema_migrations WHERE name=$1", [name]);
      await db.query(
        "INSERT INTO schema_migrations(name,sha256) VALUES($1,'unrelated')",
        [unknown],
      );
      expect(
        (await app.inject({ method: "GET", url: "/health/ready" })).statusCode,
      ).toBe(503);
      await db.query("DELETE FROM schema_migrations WHERE name=$1", [unknown]);
      await db.query(
        "INSERT INTO schema_migrations(name,sha256) VALUES($1,'wrong checksum')",
        [name],
      );
      expect(
        (await app.inject({ method: "GET", url: "/health/ready" })).statusCode,
      ).toBe(503);
      await db.query("UPDATE schema_migrations SET sha256=$2 WHERE name=$1", [
        name,
        original.sha256,
      ]);
      expect(
        (await app.inject({ method: "GET", url: "/health/ready" })).statusCode,
      ).toBe(200);
    } finally {
      await db.query("DELETE FROM schema_migrations WHERE name=$1", [unknown]);
      await db.query(
        "INSERT INTO schema_migrations(name,sha256,applied_at) VALUES($1,$2,$3) ON CONFLICT(name) DO UPDATE SET sha256=EXCLUDED.sha256,applied_at=EXCLUDED.applied_at",
        [name, original.sha256, original.applied_at],
      );
    }
  });
});

describe("legacy reviewed relationship migration", () => {
  it("backfills only known separate review items and never guesses a selected target", async () => {
    const sql = await readFile(
      new URL(
        "../packages/database/migrations/0005_review_relationship_resolution.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const separate = randomUUID(),
      unknown = randomUUID(),
      pending = randomUUID(),
      itemId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        "CREATE TEMP TABLE knowledge_items(id uuid PRIMARY KEY,origin_key text) ON COMMIT DROP; CREATE TEMP TABLE review_proposals(id uuid PRIMARY KEY,status text) ON COMMIT DROP;",
      );
      await tx.query("INSERT INTO knowledge_items VALUES($1,$2)", [
        itemId,
        `review:${separate}`,
      ]);
      await tx.query(
        "INSERT INTO review_proposals VALUES($1,'accepted'),($2,'accepted'),($3,'pending')",
        [separate, unknown, pending],
      );
      await tx.query(
        sql.replace(/^BEGIN;\s*$/gm, "").replace(/^COMMIT;\s*$/gm, ""),
      );
      const resolved = (await tx.query("SELECT * FROM review_proposals")).rows;
      expect(resolved.find((p) => p.id === separate)).toMatchObject({
        resolved_item_id: itemId,
        relationship_context_unchanged: false,
      });
      expect(resolved.find((p) => p.id === unknown)).toMatchObject({
        resolved_item_id: null,
        relationship_context_unchanged: false,
      });
      expect(resolved.find((p) => p.id === pending)).toMatchObject({
        resolved_item_id: null,
        relationship_context_unchanged: false,
      });
      await tx.query("DELETE FROM knowledge_items WHERE id=$1", [itemId]);
      expect(
        (await one(
          tx,
          "SELECT resolved_item_id FROM review_proposals WHERE id=$1",
          [separate],
        ))!.resolved_item_id,
      ).toBeNull();
    });
  });
});
