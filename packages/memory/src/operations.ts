import {
  type Database,
  type Queryable,
  one,
  enqueue,
  camel,
} from "@secondbrain/database";
import {
  type Config,
  fail,
  randomUUID,
  hash,
  ItemPatch,
} from "@secondbrain/shared";
import { privatePath, removePrivate, openPrivate } from "./files.js";
import { createWriteStream } from "node:fs";
import { open, rename, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";

export async function deletionImpact(db: Queryable, id: string) {
  const c = await one(db, "SELECT id FROM conversations WHERE id=$1", [id]);
  if (!c) fail(404, "NOT_FOUND", "Capture not found.");
  const items = (
    await db.query(
      `SELECT DISTINCT k.id,k.title,k.kind FROM knowledge_items k JOIN item_sources i ON i.item_id=k.id JOIN sources s ON s.id=i.source_id JOIN messages m ON m.id=s.message_id WHERE m.conversation_id=$1`,
      [id],
    )
  ).rows;
  return {
    items,
    backupNotice:
      "Downloaded exports and offline backups may retain this content. Erasures are replayed during restore; backups expire after their retention window.",
  };
}
export async function recordErasure(c: Config, id: string) {
  const path = resolve(c.ERASURE_MANIFEST_PATH);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const f = await open(path, "a", 0o600);
  try {
    await f.writeFile(
      JSON.stringify({
        conversationId: id,
        requestedAt: new Date().toISOString(),
      }) + "\n",
    );
    await f.sync();
  } finally {
    await f.close();
  }
  const d = await open(dirname(path), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
export async function requestDeletion(db: Queryable, id: string, c?: Config) {
  const old = await one(db, "SELECT * FROM erasures WHERE conversation_id=$1", [
    id,
  ]);
  if (old)
    return enqueue(db, "purge", `purge:${id}`, null, { conversationId: id });
  if (
    !(await one(db, "SELECT id FROM conversations WHERE id=$1 FOR UPDATE", [
      id,
    ]))
  )
    fail(404, "NOT_FOUND", "Capture not found.");
  await db.query(
    `UPDATE conversations SET state='deleting',updated_at=now() WHERE id=$1`,
    [id],
  );
  await db.query(
    `UPDATE sources SET available=false WHERE message_id IN(SELECT id FROM messages WHERE conversation_id=$1)`,
    [id],
  );
  await db.query(
    `UPDATE knowledge_items SET projection_state='invalidated' WHERE id IN(SELECT i.item_id FROM item_sources i JOIN sources s ON s.id=i.source_id WHERE NOT s.available)`,
  );
  await db.query(
    `UPDATE review_proposals SET status='invalidated' WHERE id IN(SELECT r.proposal_id FROM review_proposal_sources r JOIN sources s ON s.id=r.source_id WHERE NOT s.available)`,
  );
  await db.query(
    `UPDATE processing_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,payload='{}',result=NULL WHERE (conversation_id=$1 OR kind='answer') AND status IN('pending','retry_wait','running')`,
    [id],
  );
  // Turns that read or cited removed text lose their reply: lineage covers every
  // source the agent saw, not only what it cited.
  await db.query(
    `UPDATE agent_turns SET status='invalidated',reply='{"text":"[Removed because a source was deleted]","claims":[],"insufficientEvidence":false}',actions='[]',steps='[]',undo=NULL WHERE conversation_id=$1 OR id IN(SELECT t.turn_id FROM agent_turn_sources t JOIN sources s ON s.id=t.source_id WHERE NOT s.available)`,
    [id],
  );
  await db.query(
    `UPDATE messages SET content='[Removed because a source was deleted]' WHERE role='assistant' AND origin_key IN(SELECT 'reply:'||job_id::text FROM agent_turns WHERE status='invalidated')`,
  );
  // A turn in flight elsewhere may already have read the removed text. Restart
  // it from scratch; its fenced lease cannot commit the old result.
  await db.query(
    `UPDATE processing_jobs SET status='pending',lease_token=NULL,lease_until=NULL,run_after=now(),updated_at=now() WHERE kind='converse' AND status IN('running','retry_wait') AND conversation_id IS DISTINCT FROM $1`,
    [id],
  );
  await db.query(
    `UPDATE recall_requests SET status='invalidated',final_answer=NULL WHERE status='pending' OR id IN(SELECT r.request_id FROM recall_request_sources r JOIN sources s ON s.id=r.source_id WHERE NOT s.available)`,
  );
  await db.query(
    `DELETE FROM recall_events WHERE request_id IN(SELECT id FROM recall_requests WHERE status='invalidated')`,
  );
  await db.query(
    `UPDATE messages SET content='[Answer removed because a source was deleted]' WHERE role='assistant' AND conversation_id IN(SELECT conversation_id FROM recall_requests WHERE status='invalidated')`,
  );
  await db.query(`UPDATE exports SET invalidated_at=now()`); // conservative: includes exports still taking a snapshot
  await db.query(
    `UPDATE processing_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE kind='export' AND status IN('pending','retry_wait','running')`,
  );
  await db.query(
    `INSERT INTO erasures(conversation_id,retain_until) VALUES($1,now()+interval '40 days')`,
    [id],
  );
  if (c) await recordErasure(c, id);
  return enqueue(db, "purge", `purge:${id}`, null, { conversationId: id });
}
// Call only with the current fenced purge lease inside a transaction. Files are
// removed first; any interrupted database transaction can repeat these removals.
export async function purgeConversation(db: Queryable, c: Config, id: string) {
  const sources = (
    await db.query(
      "SELECT s.id FROM sources s JOIN messages m ON m.id=s.message_id WHERE m.conversation_id=$1",
      [id],
    )
  ).rows.map((s) => s.id);
  if (
    !sources.length &&
    !(await one(db, "SELECT id FROM conversations WHERE id=$1", [id]))
  ) {
    await db.query(
      "UPDATE erasures SET completed_at=now() WHERE conversation_id=$1",
      [id],
    );
    return;
  }
  const items = (
    await db.query(
      "SELECT DISTINCT item_id FROM item_sources WHERE source_id=ANY($1::uuid[])",
      [sources],
    )
  ).rows.map((r) => r.item_id);
  const relations = (
    await db.query(
      "SELECT DISTINCT relationship_id FROM relationship_sources WHERE source_id=ANY($1::uuid[])",
      [sources],
    )
  ).rows.map((r) => r.relationship_id);
  const attachments = (
    await db.query("SELECT * FROM attachments WHERE conversation_id=$1", [id])
  ).rows;
  for (const a of attachments) await removePrivate(c, a.storage_key);
  const exports = (
    await db.query(
      "SELECT storage_key FROM exports WHERE invalidated_at IS NOT NULL AND storage_key IS NOT NULL",
    )
  ).rows;
  for (const e of exports) await removePrivate(c, e.storage_key);
  const requests = (
    await db.query(
      "SELECT id FROM recall_requests WHERE conversation_id=$1 OR status='invalidated'",
      [id],
    )
  ).rows.map((r) => r.id);
  await db.query("DELETE FROM recall_events WHERE request_id=ANY($1::uuid[])", [
    requests,
  ]);
  await db.query(
    "DELETE FROM recall_request_sources WHERE request_id=ANY($1::uuid[]) OR source_id=ANY($2::uuid[])",
    [requests, sources],
  );
  await db.query("DELETE FROM recall_requests WHERE id=ANY($1::uuid[])", [
    requests,
  ]);
  await db.query("DELETE FROM export_sources WHERE source_id=ANY($1::uuid[])", [
    sources,
  ]);
  await db.query(
    "DELETE FROM agent_turn_sources WHERE source_id=ANY($1::uuid[]) OR turn_id IN(SELECT id FROM agent_turns WHERE conversation_id=$2)",
    [sources, id],
  );
  await db.query("DELETE FROM agent_turns WHERE conversation_id=$1", [id]);
  await db.query(
    "DELETE FROM attachment_pins WHERE attachment_id IN(SELECT id FROM attachments WHERE conversation_id=$1)",
    [id],
  );
  const proposals = (
    await db.query(
      "SELECT DISTINCT proposal_id FROM review_proposal_sources WHERE source_id=ANY($1::uuid[])",
      [sources],
    )
  ).rows.map((r) => r.proposal_id);
  await db.query(
    "DELETE FROM review_proposal_sources WHERE proposal_id=ANY($1::uuid[])",
    [proposals],
  );
  await db.query("DELETE FROM review_proposals WHERE id=ANY($1::uuid[])", [
    proposals,
  ]);
  await db.query(
    "DELETE FROM embeddings WHERE source_id=ANY($1::uuid[]) OR item_id=ANY($2::uuid[])",
    [sources, items],
  );
  // Undo snapshots of these items may hold the erased text.
  await db.query(
    "UPDATE agent_turns SET undo=NULL WHERE undo_items && $1::uuid[]",
    [items],
  );
  await db.query(
    "DELETE FROM memory_events WHERE source_id=ANY($1::uuid[]) OR item_id=ANY($2::uuid[])",
    [sources, items],
  );
  await db.query("DELETE FROM item_sources WHERE source_id=ANY($1::uuid[])", [
    sources,
  ]);
  await db.query(
    "DELETE FROM relationship_sources WHERE source_id=ANY($1::uuid[])",
    [sources],
  );
  await db.query(
    `DELETE FROM relationships WHERE id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM relationship_sources WHERE relationship_id=relationships.id)`,
    [relations],
  );
  for (const itemId of items) {
    const remaining = await one(
      db,
      "SELECT count(*)::int AS n FROM item_sources i JOIN sources s ON s.id=i.source_id WHERE i.item_id=$1 AND s.available",
      [itemId],
    );
    if (!remaining?.n) await removeItem(db, itemId);
    else {
      // Rebuild exclusively from live quoted support; never ask a model to remember
      // erased text. Each domain field is reset before the conservative rebuild.
      const current = await one(
        db,
        "SELECT kind FROM knowledge_items WHERE id=$1",
        [itemId],
      );
      const quotes = (
        await db.query(
          "SELECT i.quote FROM item_sources i JOIN sources s ON s.id=i.source_id WHERE i.item_id=$1 AND s.available ORDER BY s.created_at DESC",
          [itemId],
        )
      ).rows
        .map((r) => r.quote)
        .join("\n");
      if (current?.kind === "project")
        await db.query(
          "UPDATE projects SET current_state=$1,outcome=NULL,last_decision=NULL,blocker=NULL,next_step=NULL WHERE item_id=$2",
          [quotes, itemId],
        );
      else if (current?.kind === "task")
        await db.query(
          "UPDATE tasks SET action=$1,due_date=NULL,due_at=NULL,start_date=NULL,start_at=NULL,due_source_id=NULL WHERE item_id=$2",
          [quotes, itemId],
        );
      else if (current?.kind === "idea")
        await db.query("UPDATE ideas SET thought=$1 WHERE item_id=$2", [
          quotes,
          itemId,
        ]);
      else if (current?.kind === "memory")
        await db.query(
          `UPDATE memories SET assertion=$1,epistemic_state='uncertain' WHERE item_id=$2`,
          [quotes, itemId],
        );
      else
        await db.query(
          "UPDATE entities SET canonical_name=$1,aliases='{}' WHERE item_id=$2",
          ["Retained entity", itemId],
        );
      await db.query(
        `UPDATE knowledge_items SET title='Retained knowledge',revision=revision+1,projection_state='valid',updated_at=now() WHERE id=$1`,
        [itemId],
      );
      // Replay only individually sourced manual fields, never a historical snapshot
      // which may still contain information from the erased conversation.
      const manual = (
        await db.query(
          `SELECT s.id,s.content FROM item_sources i JOIN sources s ON s.id=i.source_id JOIN messages m ON m.id=s.message_id JOIN conversations c ON c.id=m.conversation_id WHERE i.item_id=$1 AND s.available AND c.mode='manual' ORDER BY s.created_at,s.id`,
          [itemId],
        )
      ).rows;
      for (const source of manual) {
        if (!source.content.startsWith("Manual update to ")) continue;
        let parsed;
        try {
          parsed = ItemPatch.safeParse(
            JSON.parse(source.content.slice(source.content.indexOf("\n") + 1)),
          );
        } catch {
          continue;
        }
        if (!parsed.success) continue;
        const patch = parsed.data;
        if (
          patch.aliases &&
          (current?.kind === "project" || current?.kind === "entity")
        )
          await db.query(
            `UPDATE ${current.kind === "project" ? "projects" : "entities"} SET aliases=$1 WHERE item_id=$2`,
            [patch.aliases, itemId],
          );
        if (patch.title)
          await db.query("UPDATE knowledge_items SET title=$1 WHERE id=$2", [
            patch.title,
            itemId,
          ]);
        if (patch.content !== undefined) {
          const table = {
            project: "projects",
            task: "tasks",
            idea: "ideas",
            memory: "memories",
            entity: "entities",
          }[current!.kind as "project"];
          const col = {
            project: "current_state",
            task: "action",
            idea: "thought",
            memory: "assertion",
            entity: "canonical_name",
          }[current!.kind as "project"];
          await db.query(`UPDATE ${table} SET ${col}=$1 WHERE item_id=$2`, [
            patch.content,
            itemId,
          ]);
        }
        if (current?.kind === "project")
          for (const [field, col] of Object.entries({
            outcome: "outcome",
            currentState: "current_state",
            lastDecision: "last_decision",
            blocker: "blocker",
            nextStep: "next_step",
          }))
            if (field in patch)
              await db.query(`UPDATE projects SET ${col}=$1 WHERE item_id=$2`, [
                (patch as any)[field],
                itemId,
              ]);
        if (
          current?.kind === "task" &&
          (patch.dueDate !== undefined || patch.dueAt !== undefined)
        )
          await db.query(
            "UPDATE tasks SET due_date=$1,due_at=$2,due_source_id=$3 WHERE item_id=$4",
            [patch.dueDate ?? null, patch.dueAt ?? null, source.id, itemId],
          );
      }
      const { event } = await import("./domain.js");
      await event(
        db,
        itemId,
        randomUUID(),
        "restored",
        "worker",
        null,
        null,
        "Rebuilt solely from remaining source quotes after erasure",
      );
    }
  }
  await db.query(
    "UPDATE sources SET supersedes_source_id=NULL WHERE supersedes_source_id=ANY($1::uuid[])",
    [sources],
  );
  await db.query(
    "UPDATE tasks SET due_date=NULL,due_at=NULL,start_date=NULL,start_at=NULL,due_source_id=NULL WHERE due_source_id=ANY($1::uuid[])",
    [sources],
  );
  await db.query("DELETE FROM sources WHERE id=ANY($1::uuid[])", [sources]);
  await db.query(
    `UPDATE processing_jobs SET payload='{}',result=NULL,provider_metadata=NULL,error_code=NULL,conversation_id=NULL WHERE conversation_id=$1`,
    [id],
  );
  await db.query("DELETE FROM messages WHERE conversation_id=$1", [id]);
  await db.query("DELETE FROM attachments WHERE conversation_id=$1", [id]);
  await db.query("DELETE FROM conversations WHERE id=$1", [id]);
  await db.query(
    "UPDATE erasures SET completed_at=now() WHERE conversation_id=$1",
    [id],
  );
}
/** Removes an item and everything that points at it. */
export async function removeItem(db: Queryable, id: string) {
  await db.query("DELETE FROM embeddings WHERE item_id=$1", [id]);
  await db.query(
    "UPDATE agent_turns SET undo=NULL WHERE undo_items && ARRAY[$1]::uuid[]",
    [id],
  );
  await db.query("DELETE FROM memory_events WHERE item_id=$1", [id]);
  await db.query("DELETE FROM item_sources WHERE item_id=$1", [id]);
  await db.query(
    "DELETE FROM relationship_sources WHERE relationship_id IN(SELECT id FROM relationships WHERE from_item_id=$1 OR to_item_id=$1)",
    [id],
  );
  await db.query(
    "DELETE FROM relationships WHERE from_item_id=$1 OR to_item_id=$1",
    [id],
  );
  await db.query("UPDATE tasks SET project_id=NULL WHERE project_id=$1", [id]);
  await db.query("UPDATE ideas SET project_id=NULL WHERE project_id=$1", [id]);
  await db.query(
    "UPDATE recall_requests SET project_id=NULL WHERE project_id=$1",
    [id],
  );
  await db.query(
    "UPDATE memories SET supersedes_item_id=NULL WHERE supersedes_item_id=$1",
    [id],
  );
  for (const table of ["tasks", "ideas", "memories", "entities", "projects"])
    await db.query(`DELETE FROM ${table} WHERE item_id=$1`, [id]);
  await db.query("DELETE FROM knowledge_items WHERE id=$1", [id]);
}
export async function retainAudio(db: Queryable, c: Config) {
  const rows = (
    await db.query(
      `SELECT * FROM attachments a WHERE state IN('available','purging') AND retain_until<=now() AND NOT EXISTS(SELECT 1 FROM processing_jobs j WHERE j.conversation_id=a.conversation_id AND j.kind='transcribe' AND j.status<>'succeeded') AND NOT EXISTS(SELECT 1 FROM attachment_pins p WHERE p.attachment_id=a.id AND p.expires_at>now()) FOR UPDATE`,
    )
  ).rows;
  for (const row of rows) {
    await removePrivate(c, row.storage_key);
    await db.query(
      `UPDATE attachments SET state='purged',purged_at=now() WHERE id=$1`,
      [row.id],
    );
  }
  for (const row of (
    await db.query(
      "SELECT * FROM exports WHERE expires_at<=now() OR invalidated_at IS NOT NULL",
    )
  ).rows) {
    if (row.storage_key) await removePrivate(c, row.storage_key);
    await db.query("UPDATE exports SET storage_key=NULL WHERE job_id=$1", [
      row.job_id,
    ]);
  }
  await db.query("DELETE FROM attachment_pins WHERE expires_at<=now()");
}
export async function exportData(
  db: Database,
  c: Config,
  job: any,
  signal: AbortSignal,
) {
  const key = `exports/${job.id}.zip`,
    stage = privatePath(c, `staging/${job.id}.part`);
  const conn = await db.pool.connect();
  const archive = new ZipArchive({ zlib: { level: 6 } }),
    output = createWriteStream(stage, { flags: "w", mode: 0o600 });
  const completion = pipeline(archive, output, { signal });
  try {
    await conn.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const e = await one(
      conn,
      "SELECT * FROM exports WHERE job_id=$1 FOR UPDATE",
      [job.id],
    );
    if (!e || e.invalidated_at)
      fail(409, "INVALIDATED", "Export was invalidated.");
    archive.append(
      JSON.stringify({
        format: "secondbrain",
        version: 1,
        createdAt: new Date().toISOString(),
      }),
      { name: "manifest.json" },
    );
    for (const table of [
      "conversations",
      "messages",
      "sources",
      "knowledge_items",
      "memories",
      "projects",
      "tasks",
      "ideas",
      "entities",
      "item_sources",
      "relationships",
      "relationship_sources",
      "memory_events",
    ]) {
      const filters: Record<string, string> = {
        conversations: "state<>'deleting'",
        messages:
          "conversation_id IN(SELECT id FROM conversations WHERE state<>'deleting')",
        sources: "available",
        knowledge_items: "projection_state='valid'",
        memories:
          "item_id IN(SELECT id FROM knowledge_items WHERE projection_state='valid')",
        projects:
          "item_id IN(SELECT id FROM knowledge_items WHERE projection_state='valid')",
        tasks:
          "item_id IN(SELECT id FROM knowledge_items WHERE projection_state='valid')",
        ideas:
          "item_id IN(SELECT id FROM knowledge_items WHERE projection_state='valid')",
        entities:
          "item_id IN(SELECT id FROM knowledge_items WHERE projection_state='valid')",
        item_sources:
          "item_id IN(SELECT id FROM knowledge_items WHERE projection_state='valid') AND source_id IN(SELECT id FROM sources WHERE available)",
        relationships:
          "from_item_id IN(SELECT id FROM knowledge_items WHERE projection_state='valid') AND to_item_id IN(SELECT id FROM knowledge_items WHERE projection_state='valid')",
        relationship_sources:
          "source_id IN(SELECT id FROM sources WHERE available)",
        memory_events:
          "item_id IN(SELECT id FROM knowledge_items WHERE projection_state='valid')",
      };
      const rows = (
        await conn.query(`SELECT * FROM ${table} WHERE ${filters[table]}`)
      ).rows;
      archive.append(JSON.stringify(camel(rows), null, 2), {
        name: `records/${table}.json`,
      });
    }
    const sources = (await conn.query("SELECT * FROM sources WHERE available"))
      .rows;
    for (const s of sources)
      archive.append(s.content, { name: `sources/${s.id}.md` });
    const audio = job.payload.includeAudio
      ? (
          await conn.query(
            `SELECT * FROM attachments WHERE state='available' AND conversation_id IN(SELECT id FROM conversations WHERE state<>'deleting') FOR SHARE`,
          )
        ).rows
      : [];
    for (const s of sources)
      await conn.query(
        "INSERT INTO export_sources(job_id,source_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [job.id, s.id],
      );
    for (const a of audio)
      await conn.query(
        `INSERT INTO attachment_pins(attachment_id,job_id,expires_at) VALUES($1,$2,now()+interval '1 hour') ON CONFLICT DO NOTHING`,
        [a.id, job.id],
      );
    await conn.query("COMMIT");
    for (const a of audio) {
      const f = await openPrivate(c, a.storage_key);
      archive.append(f.createReadStream(), {
        name: `audio/${a.id}.${a.storage_key.split(".").pop()}`,
      });
    }
    await archive.finalize();
    await completion;
    const f = await open(stage, "r");
    try {
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(stage, privatePath(c, key));
    return { storageKey: key };
  } catch (e) {
    await conn.query("ROLLBACK");
    archive.abort();
    output.destroy();
    await completion.catch(() => {});
    throw e;
  } finally {
    conn.release();
    await db.query("DELETE FROM attachment_pins WHERE job_id=$1", [job.id]);
  }
}
