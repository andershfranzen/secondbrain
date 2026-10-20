import {
  type Database,
  type Queryable,
  type Row,
  one,
  enqueue,
  indexText,
} from "@secondbrain/database";
import {
  type AIProvider,
  ProviderError,
  withProviderUsage,
  type ProviderUsage,
} from "@secondbrain/ai";
import { type Config, randomUUID } from "@secondbrain/shared";
import { addSource } from "./domain.js";
import { privatePath } from "./files.js";
import { purgeConversation, exportData, retainAudio } from "./operations.js";
import { runTurn, commitTurn } from "./agent.js";
import { sendBrief } from "./brief.js";
const providerKinds = ["transcribe", "embed", "converse"];
async function failDependents(tx: Queryable, job: Row, _code: string) {
  // A capture fails visibly when it could not be organized. Missing vectors
  // only reduce semantic search; the capture itself stays usable.
  if (job.conversation_id && job.kind !== "embed")
    await tx.query(
      `UPDATE conversations SET state='failed' WHERE id=$1 AND mode IN('text','audio') AND state<>'deleting'`,
      [job.conversation_id],
    );
  await tx.query("DELETE FROM attachment_pins WHERE job_id=$1", [job.id]);
}
export async function claimJob(db: Database, id: string, ai: AIProvider) {
  return db.transaction(async (tx) => {
    const settings = (await one(tx, "SELECT * FROM app_settings"))!;
    if (settings.maintenance) return;
    const row = await one(
      tx,
      `SELECT * FROM processing_jobs WHERE id=$1 AND status IN('pending','retry_wait') AND run_after<=now() AND attempts<max_attempts FOR UPDATE`,
      [id],
    );
    if (!row) return;
    const unavailable =
      row.kind === "embed" && ai.capabilities?.embeddings === false
        ? "EMBEDDINGS_NOT_CONFIGURED"
        : row.kind === "transcribe" && ai.capabilities?.transcription === false
          ? "TRANSCRIPTION_NOT_CONFIGURED"
          : null;
    if (unavailable) {
      await tx.query(
        "UPDATE processing_jobs SET blocked_reason=$2 WHERE id=$1",
        [id, unavailable],
      );
      return;
    }
    if (
      providerKinds.includes(row.kind) &&
      (!settings.cloud_consent_at || !ai.configured)
    ) {
      await tx.query(
        "UPDATE processing_jobs SET blocked_reason=$2 WHERE id=$1",
        [
          id,
          !settings.cloud_consent_at
            ? "CONSENT_REQUIRED"
            : "PROVIDER_NOT_CONFIGURED",
        ],
      );
      return;
    }
    if (row.kind === "converse") {
      // Turns run one at a time, oldest first: a question asked right after a
      // brain dump must see what that dump recorded.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('secondbrain:converse',0))",
      );
      if (
        await one(
          tx,
          `SELECT 1 FROM processing_jobs WHERE kind='converse' AND id<>$1 AND (status='running' OR (status='pending' AND blocked_reason IS NULL AND (created_at,id)<($2,$1))) LIMIT 1`,
          [row.id, row.created_at],
        )
      )
        return;
    }
    if (row.conversation_id) {
      const c = await one(tx, "SELECT state FROM conversations WHERE id=$1", [
        row.conversation_id,
      ]);
      if (!c || c.state === "deleting") {
        await tx.query(
          `UPDATE processing_jobs SET status='cancelled' WHERE id=$1`,
          [id],
        );
        return;
      }
    }
    return one(
      tx,
      `UPDATE processing_jobs SET status='running',attempts=attempts+1,blocked_reason=NULL,progress=NULL,lease_token=$2,lease_until=now()+interval '120 seconds',updated_at=now() WHERE id=$1 RETURNING *`,
      [id, randomUUID()],
    );
  });
}
export async function withLease<T>(
  db: Database,
  job: Row,
  fn: (tx: Queryable) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    if (job.conversation_id) {
      const conversation = await one(
        tx,
        `SELECT state FROM conversations WHERE id=$1 FOR UPDATE`,
        [job.conversation_id],
      );
      if (!conversation || conversation.state === "deleting")
        throw new ProviderError("LEASE_LOST", false);
    }
    const current = await one(
      tx,
      `SELECT id FROM processing_jobs WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE`,
      [job.id, job.lease_token],
    );
    if (!current) throw new ProviderError("LEASE_LOST", false);
    if ((await one(tx, "SELECT maintenance FROM app_settings"))?.maintenance)
      throw new ProviderError("MAINTENANCE", true);
    return fn(tx);
  });
}
export async function processJob(
  db: Database,
  c: Config,
  ai: AIProvider,
  id: string,
) {
  const usage: ProviderUsage[] = [];
  return withProviderUsage(usage, () => executeJob(db, c, ai, id, usage));
}
async function executeJob(
  db: Database,
  c: Config,
  ai: AIProvider,
  id: string,
  usage: ProviderUsage[],
) {
  const job = await claimJob(db, id, ai);
  // Not claimed (blocked, or waiting for an earlier turn): nothing ran.
  if (!job) return false;
  const started = performance.now();
  const metadata = () =>
    JSON.stringify([
      {
        attempt: job.attempts,
        durationMs: Math.round(performance.now() - started),
        calls: usage,
      },
    ]);
  const controller = new AbortController(),
    timeout = setTimeout(
      () => controller.abort(),
      job.kind === "transcribe"
        ? 1800000
        : job.kind === "converse"
          ? 600000
          : 90000,
    );
  const heartbeat = setInterval(() => {
    void db
      .query(
        `UPDATE processing_jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING id`,
        [id, job.lease_token],
      )
      .then((r) => {
        if (!r.rowCount) controller.abort();
      })
      .catch(() => controller.abort());
  }, 20000);
  try {
    let result: any = {};
    if (job.kind === "converse") {
      await db.query(
        `UPDATE conversations SET state='organizing' WHERE id=$1 AND mode IN('text','audio') AND state NOT IN('deleting','ready')`,
        [job.conversation_id],
      );
      result = await runTurn(db, ai, job, controller.signal);
    } else if (job.kind === "transcribe") {
      const a = (await one(
        db,
        `SELECT * FROM attachments WHERE conversation_id=$1 AND state='available'`,
        [job.conversation_id],
      ))!;
      if (!a) throw new ProviderError("AUDIO_UNAVAILABLE", false);
      await db.query(
        `UPDATE conversations SET state='transcribing' WHERE id=$1 AND state<>'deleting'`,
        [job.conversation_id],
      );
      result = await ai.transcribe(
        privatePath(c, a.storage_key),
        controller.signal,
      );
      result.attachmentId = a.id;
      result.durationMs = a.duration_ms;
    } else if (job.kind === "embed") {
      const rows = job.payload.itemId
        ? (
            await db.query(
              `SELECT * FROM embeddings WHERE item_id=$1 AND item_revision=$2 AND model='lexical-v1'`,
              [job.payload.itemId, job.payload.revision],
            )
          ).rows
        : job.payload.sourceId
          ? (
              await db.query(
                `SELECT e.* FROM embeddings e JOIN sources s ON s.id=e.source_id WHERE s.id=$1 AND s.available AND e.model='lexical-v1'`,
                [job.payload.sourceId],
              )
            ).rows
          : (
              await db.query(
                `SELECT e.* FROM embeddings e JOIN sources s ON s.id=e.source_id JOIN messages m ON m.id=s.message_id WHERE m.conversation_id=$1 AND s.available AND e.model='lexical-v1'`,
                [job.conversation_id],
              )
            ).rows;
      const entries = [];
      for (let i = 0; i < rows.length; i += 32) {
        const batch = rows.slice(i, i + 32),
          out = await ai.embed(
            batch.map((r) => r.content),
            AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
          );
        entries.push(
          ...batch.map((r, j) => ({ row: r, vector: out.vectors[j] })),
        );
      }
      result = { entries, model: ai.model };
    } else if (job.kind === "export")
      result = await exportData(db, c, job, controller.signal);
    else if (job.kind === "brief")
      result = await sendBrief(db, c, job.payload.date, controller.signal);
    await withLease(db, job, async (tx) => {
      if (job.kind === "transcribe") {
        for (const [i, segment] of result.segments.entries())
          if (segment.text.trim())
            await addSource(
              tx,
              job.conversation_id,
              segment.text,
              `transcript:${result.attachmentId}:1:${i}`,
              result.attachmentId,
              segment.startMs,
              Math.min(segment.endMs, result.durationMs),
            );
        await enqueue(
          tx,
          "converse",
          `converse:${job.conversation_id}:audio`,
          job.conversation_id,
          { hint: "note" },
          id,
        );
      }
      if (job.kind === "converse") await commitTurn(tx, job, result);
      if (job.kind === "embed") {
        for (const entry of result.entries) {
          const r = entry.row;
          if (r.item_id) {
            const live = await one(
              tx,
              "SELECT revision,projection_state FROM knowledge_items WHERE id=$1",
              [r.item_id],
            );
            if (
              live?.revision !== r.item_revision ||
              live?.projection_state !== "valid"
            )
              continue;
          } else if (
            !(
              await one(tx, "SELECT available FROM sources WHERE id=$1", [
                r.source_id,
              ])
            )?.available
          )
            continue;
          await tx.query(
            `INSERT INTO embeddings(source_id,item_id,item_revision,model,input_sha256,chunk_index,start_offset,end_offset,content,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector) ON CONFLICT DO NOTHING`,
            [
              r.source_id,
              r.item_id,
              r.item_revision,
              result.model,
              r.input_sha256,
              r.chunk_index,
              r.start_offset,
              r.end_offset,
              r.content,
              JSON.stringify(entry.vector),
            ],
          );
        }
        // Cut over only when every current lexical chunk has this model's vector.
        const missing = await one(
          tx,
          `SELECT 1 FROM embeddings l LEFT JOIN embeddings v ON v.model=$1 AND v.embedding IS NOT NULL AND v.input_sha256=l.input_sha256 AND v.chunk_index=l.chunk_index AND ((v.source_id=l.source_id) OR(v.item_id=l.item_id AND v.item_revision=l.item_revision)) WHERE l.model='lexical-v1' AND v.id IS NULL LIMIT 1`,
          [result.model],
        );
        if (!missing)
          await tx.query("UPDATE app_settings SET active_embedding_model=$1", [
            result.model,
          ]);
      }
      if (job.kind === "purge")
        await purgeConversation(tx, c, job.payload.conversationId);
      if (job.kind === "retention") await retainAudio(tx, c);
      if (job.kind === "export") {
        const e = await one(
          tx,
          "SELECT invalidated_at FROM exports WHERE job_id=$1",
          [id],
        );
        if (e?.invalidated_at)
          throw new ProviderError("EXPORT_INVALIDATED", false);
        await tx.query("UPDATE exports SET storage_key=$2 WHERE job_id=$1", [
          id,
          result.storageKey,
        ]);
      }
      // Content-heavy intermediates are never retained after applying results;
      // the agent turn keeps its own reply and lineage (smaller deletion surface).
      await tx.query(
        `UPDATE processing_jobs SET status='succeeded',result=$3,provider_metadata=coalesce(provider_metadata,'[]'::jsonb)||$4::jsonb,lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`,
        [id, job.lease_token, null, metadata()],
      );
    });
  } catch (error) {
    const e =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            controller.signal.aborted
              ? "PROVIDER_TIMEOUT"
              : "PROCESSING_FAILED",
            true,
          );
    if (e.code === "LEASE_LOST") return;
    const retry = e.retryable && job.attempts < job.max_attempts,
      backoff = [10000, 60000, 300000, 1800000][Math.min(job.attempts - 1, 3)]!;
    await db.transaction(async (tx) => {
      const changed = await tx.query(
        `UPDATE processing_jobs SET status=$3,error_code=$4,provider_metadata=coalesce(provider_metadata,'[]'::jsonb)||$6::jsonb,lease_token=NULL,lease_until=NULL,run_after=now()+($5*interval '1 millisecond'),updated_at=now() WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING id`,
        [
          id,
          job.lease_token,
          retry ? "retry_wait" : "failed",
          e.code,
          Math.max(e.retryAfter, backoff + Math.random() * 1000),
          metadata(),
        ],
      );
      if (changed.rowCount && !retry) await failDependents(tx, job, e.code);
    });
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}
export async function recoverJobs(db: Database, ai: AIProvider) {
  await db.transaction(async (tx) => {
    const expired = await tx.query(
      `UPDATE processing_jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'retry_wait' END,lease_token=NULL,lease_until=NULL,error_code='LEASE_EXPIRED',run_after=now(),updated_at=now() WHERE status='running' AND lease_until<=now() RETURNING *`,
    );
    for (const job of expired.rows)
      if (job.status === "failed")
        await failDependents(tx, job, "LEASE_EXPIRED");
    const s = (await one(tx, "SELECT * FROM app_settings"))!;
    if (s.cloud_consent_at && ai.configured)
      await tx.query(
        `UPDATE processing_jobs SET blocked_reason=NULL WHERE blocked_reason IN('CONSENT_REQUIRED','PROVIDER_NOT_CONFIGURED')`,
      );
    if (ai.capabilities?.embeddings !== false)
      await tx.query(
        "UPDATE processing_jobs SET blocked_reason=NULL WHERE blocked_reason='EMBEDDINGS_NOT_CONFIGURED'",
      );
    if (ai.capabilities?.transcription !== false)
      await tx.query(
        "UPDATE processing_jobs SET blocked_reason=NULL WHERE blocked_reason='TRANSCRIPTION_NOT_CONFIGURED'",
      );
    if (
      s.cloud_consent_at &&
      ai.configured &&
      ai.capabilities?.embeddings !== false
    ) {
      const missing = (
        await tx.query(
          `SELECT DISTINCT l.item_id,l.item_revision,m.conversation_id FROM embeddings l LEFT JOIN embeddings v ON v.model=$1 AND v.embedding IS NOT NULL AND v.input_sha256=l.input_sha256 AND v.chunk_index=l.chunk_index AND (v.source_id=l.source_id OR (v.item_id=l.item_id AND v.item_revision=l.item_revision)) LEFT JOIN sources source ON source.id=l.source_id LEFT JOIN messages m ON m.id=source.message_id WHERE l.model='lexical-v1' AND v.id IS NULL LIMIT 100`,
          [ai.model],
        )
      ).rows;
      for (const row of missing)
        await enqueue(
          tx,
          "embed",
          row.item_id
            ? `reindex-item:${row.item_id}:${row.item_revision}:${ai.model}`
            : `reindex-source:${row.conversation_id}:${ai.model}`,
          row.item_id ? null : row.conversation_id,
          row.item_id
            ? { itemId: row.item_id, revision: row.item_revision }
            : {},
        );
    }

    await enqueue(
      tx,
      "retention",
      `retention:${Math.floor(Date.now() / 3600000)}`,
      null,
    );
  });
}
