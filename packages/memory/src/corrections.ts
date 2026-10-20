import type { Queryable, Row } from "@secondbrain/database";
import { localStamp } from "./calendar.js";

/**
 * Where the user corrected the agent: a turn they undid, or their own edit to
 * something the agent recorded. These are the agent's mistakes in real use,
 * the material for new evaluation cases.
 */
export type CorrectionNote = { text: string; at: string };
export type Correction =
  | {
      kind: "undo";
      at: string;
      turnId: string;
      /** The message the agent acted on. */
      notes: CorrectionNote[];
      messageKind: string;
      /** What the agent did, as it reported it. */
      undid: { type: string; kind: string; title: string }[];
    }
  | {
      kind: "edit";
      at: string;
      itemId: string;
      itemKind: string;
      /** The user's notes the item was recorded from, before the edit. */
      notes: CorrectionNote[];
      changed: string[];
      before: ItemFields;
      after: ItemFields;
    };
export type ItemFields = {
  title: string;
  content: string;
  status: string | null;
  requestedBy: string | null;
  certainty: string;
  lifecycle: string;
  start: string | null;
  due: string | null;
  dueHint: string | null;
};
const fields = (s: Row, timeZone: string): ItemFields => ({
  title: s.title,
  content: s.content,
  status: s.status ?? null,
  requestedBy: s.requestedBy ?? null,
  certainty: s.certainty,
  lifecycle: s.lifecycle,
  start: localStamp(s.startDate ?? null, s.startAt ?? null, timeZone),
  due: localStamp(s.dueDate ?? null, s.dueAt ?? null, timeZone),
  dueHint: s.dueHint ?? null,
});
/** Closing, starting or completing a task is progress, not a correction. */
const progress = (before: ItemFields, after: ItemFields) =>
  before.status !== after.status &&
  !["completed", "cancelled"].includes(before.status ?? "");

export async function corrections(
  db: Queryable,
  since: Date,
): Promise<Correction[]> {
  const { timezone } = (await db.query("SELECT timezone FROM app_settings"))
    .rows[0] ?? { timezone: "UTC" };
  const out: Correction[] = [];
  for (const t of (
    await db.query(
      `SELECT t.id,t.undone_at,t.actions,t.message_kind,m.content,m.created_at
       FROM agent_turns t LEFT JOIN messages m ON m.id=t.message_id
       WHERE t.status='undone' AND t.undone_at>=$1 ORDER BY t.undone_at`,
      [since],
    )
  ).rows)
    out.push({
      kind: "undo",
      at: t.undone_at.toISOString(),
      turnId: t.id,
      notes: t.content
        ? [{ text: t.content, at: t.created_at.toISOString() }]
        : [],
      messageKind: t.message_kind,
      undid: (t.actions ?? []).map((a: Row) => ({
        type: a.type,
        kind: a.kind,
        title: a.title,
      })),
    });
  // The user's own edits to items the agent created.
  for (const e of (
    await db.query(
      `SELECT e.item_id,e.created_at,e.before_snapshot,e.after_snapshot,k.kind,
         coalesce((SELECT s.content FROM sources s WHERE s.id=e.source_id),'') AS edit_text
       FROM memory_events e JOIN knowledge_items k ON k.id=e.item_id
       WHERE e.actor='user' AND e.event_type IN('updated','archived','superseded')
         AND e.before_snapshot IS NOT NULL AND e.created_at>=$1
         AND EXISTS(SELECT 1 FROM memory_events c WHERE c.item_id=e.item_id AND c.actor='worker' AND c.event_type='created')
       ORDER BY e.created_at`,
      [since],
    )
  ).rows) {
    // Ticking a task off from the morning brief is not a correction either.
    if (e.edit_text.startsWith("Marked done from the morning brief")) continue;
    const before = fields(e.before_snapshot, timezone),
      after = fields(e.after_snapshot, timezone);
    const changed = (Object.keys(before) as (keyof ItemFields)[]).filter(
      (k) => before[k] !== after[k],
    );
    if (
      !changed.length ||
      (changed.every((k) => k === "status") && progress(before, after))
    )
      continue;
    const notes = (
      await db.query(
        `SELECT DISTINCT s.content,m.created_at FROM item_sources i
         JOIN sources s ON s.id=i.source_id JOIN messages m ON m.id=s.message_id
         JOIN conversations c ON c.id=m.conversation_id
         WHERE i.item_id=$1 AND s.available AND s.kind='note' AND c.mode<>'manual' AND m.created_at<$2
         ORDER BY m.created_at`,
        [e.item_id, e.created_at],
      )
    ).rows.map((n) => ({ text: n.content, at: n.created_at.toISOString() }));
    out.push({
      kind: "edit",
      at: e.created_at.toISOString(),
      itemId: e.item_id,
      itemKind: e.kind,
      notes,
      changed,
      before,
      after,
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
