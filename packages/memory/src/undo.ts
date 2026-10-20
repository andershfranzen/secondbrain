import { type Database, one } from "@secondbrain/database";
import { fail, operationId } from "@secondbrain/shared";
import { event } from "./domain.js";
import { removeItem } from "./operations.js";
import { type ItemSnapshot, type TurnUndo, snapshot } from "./agent.js";

/** JSON with sorted keys: stored snapshots come back from jsonb reordered. */
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((value as any)[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
/** An item's stored state, ignoring its revision counter and update time. */
function state(s: ItemSnapshot) {
  const { revision: _r, updated_at: _u, ...item } = s.item;
  return stable([item, s.detail, s.sources.map(stable).sort()]);
}

const quoted = (column: string) => `"${column.replaceAll('"', '""')}"`;

/**
 * Puts back what one turn changed: items it created are removed, items it
 * updated return to their earlier rows, and the links it added are removed.
 * The user's note stays. A later change to any of those items blocks the undo,
 * so it can never silently discard newer work.
 */
export async function undoTurn(db: Database, turnId: string) {
  return db.transaction(async (tx) => {
    const turn = await one(
      tx,
      "SELECT * FROM agent_turns WHERE id=$1 FOR UPDATE",
      [turnId],
    );
    if (!turn) fail(404, "NOT_FOUND", "Turn not found.");
    if (turn.status === "undone")
      fail(409, "ALREADY_UNDONE", "Already undone.");
    if (turn.status !== "completed" || !turn.undo)
      fail(409, "NOTHING_TO_UNDO", "There is nothing to undo here.");
    const undo = turn.undo as TurnUndo;
    const ids: string[] = turn.undo_items;
    await tx.query(
      "SELECT id FROM knowledge_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [ids],
    );
    // Allowed only while every item is exactly as this turn left it, which
    // also holds again after the later changes were themselves undone.
    const changed: string[] = [];
    for (const left of undo.after) {
      const now = await one(
        tx,
        "SELECT title,projection_state FROM knowledge_items WHERE id=$1",
        [left.id],
      );
      if (
        !now ||
        now.projection_state !== "valid" ||
        state(await snapshot(tx, left.id)) !== state(left) ||
        (await one(
          tx,
          "SELECT 1 FROM relationships WHERE (from_item_id=$1 OR to_item_id=$1) AND created_at>$2 LIMIT 1",
          [left.id, turn.created_at],
        ))
      )
        changed.push(now?.title ?? left.item.title);
    }
    if (changed.length)
      fail(
        409,
        "CHANGED_SINCE",
        `Changed since: ${changed.join(", ")}. Undo the later change first.`,
      );
    const reason = "Undone by the user";
    for (const r of undo.restored) {
      const before = await one(tx, "SELECT * FROM item_records WHERE id=$1", [
        r.id,
      ]);
      await tx.query(
        `UPDATE knowledge_items k SET title=b.title,certainty=b.certainty,lifecycle=b.lifecycle,revision=k.revision+1,updated_at=now()
         FROM json_populate_record(NULL::knowledge_items,$2) b WHERE k.id=$1`,
        [r.id, JSON.stringify(r.item)],
      );
      if (r.detail) {
        const columns = Object.keys(r.detail).filter(
          (c) => c !== "item_id" && c !== "kind",
        );
        await tx.query(
          `UPDATE ${quoted(r.table)} t SET ${columns.map((c) => `${quoted(c)}=b.${quoted(c)}`).join(",")}
           FROM json_populate_record(NULL::${quoted(r.table)},$2) b WHERE t.item_id=$1`,
          [r.id, JSON.stringify(r.detail)],
        );
      }
      await tx.query(
        `DELETE FROM item_sources i WHERE i.item_id=$1 AND NOT EXISTS(
           SELECT 1 FROM jsonb_array_elements($2::jsonb) e
           WHERE e->>0=i.source_id::text AND (e->>1)::int=i.start_offset AND (e->>2)::int=i.end_offset AND e->>3=i.role)`,
        [r.id, JSON.stringify(r.sources)],
      );
      await event(
        tx,
        r.id,
        operationId(`undo:${turn.id}:${r.id}`),
        "restored",
        "user",
        before,
        null,
        reason,
      );
    }
    // Restored first: an updated item may point at a project this turn created.
    for (const id of undo.created) await removeItem(tx, id);
    // Relationships this turn inserted carry its origin key.
    const prefix = `agent:${turn.job_id}:%`;
    await tx.query(
      "DELETE FROM relationship_sources WHERE relationship_id IN(SELECT id FROM relationships WHERE origin_key LIKE $1)",
      [prefix],
    );
    await tx.query("DELETE FROM relationships WHERE origin_key LIKE $1", [
      prefix,
    ]);
    await tx.query(
      "UPDATE agent_turns SET status='undone',undone_at=now(),undo=NULL WHERE id=$1",
      [turn.id],
    );
    // Follow-up turns see that this was taken back.
    await tx.query(
      "UPDATE messages SET content='[Undone by the user] '||content WHERE origin_key=$1 AND role='assistant'",
      [`reply:${turn.job_id}`],
    );
    return { undone: undo.created.length + undo.restored.length };
  });
}
