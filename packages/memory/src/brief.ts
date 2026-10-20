import { type Queryable, one, enqueue } from "@secondbrain/database";
import { type Config } from "@secondbrain/shared";
import { ProviderError } from "@secondbrain/ai";
import { agenda, addDays, localDate } from "./calendar.js";

/**
 * The morning brief: one push a day from the calendar, built from the ledger
 * without a model. Quiet days send nothing.
 */
export type Brief = { title: string; message: string; priority: number };

const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const time = (at: Date | string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
const SECTION = 6;

export async function composeBrief(
  db: Queryable,
  { today, timeZone }: { today: string; timeZone: string },
): Promise<Brief | null> {
  const week = addDays(today, 6);
  const { tasks } = await agenda(db, {
    from: today,
    to: week,
    today,
    timeZone,
  });
  const who = (r: Record<string, any>) =>
    r.requested_by ? `, for ${r.requested_by}` : "";
  const overdue: string[] = [],
    now: string[] = [],
    soon: string[] = [];
  for (const r of tasks) {
    const due = r.due_day,
      starts = r.start_day;
    if (due && due < today)
      overdue.push(`${r.title} (due ${day(due)}${who(r)})`);
    else if (due === today)
      now.push(
        `${r.title} (due today${r.due_at ? ` ${time(r.due_at, timeZone)}` : ""}${who(r)})`,
      );
    else if (starts === today)
      now.push(
        `${r.title}${r.start_at ? ` at ${time(r.start_at, timeZone)}` : " (starts today)"}`,
      );
    else if (due && due <= week)
      soon.push(`${r.title} (due ${day(due)}${who(r)})`);
    else if (starts && starts > today && starts <= week)
      soon.push(
        `${r.title} (${r.start_at ? `${day(starts)} ${time(r.start_at, timeZone)}` : `starts ${day(starts)}`})`,
      );
  }
  // Commitments with a deadline in the next two weeks that haven't come up for two weeks.
  const quiet = (
    await db.query(
      `SELECT r.title,r.requested_by,coalesce(r.due_date,(r.due_at AT TIME ZONE $2)::date)::text AS due_day
       FROM item_records r
       WHERE r.kind='task' AND r.status IN('open','in_progress') AND r.lifecycle='active' AND r.projection_state='valid'
         AND coalesce(r.due_date,(r.due_at AT TIME ZONE $2)::date) BETWEEN $1::date AND $1::date+14
         AND coalesce(r.last_mentioned_at,r.created_at) < $1::date-14
       ORDER BY due_day,r.title LIMIT ${SECTION}`,
      [today, timeZone],
    )
  ).rows.map((r) => `${r.title} (due ${day(r.due_day)}${who(r)})`);
  const sections = [
    ["Overdue", overdue],
    ["Today", now],
    ["This week", soon],
    ["Gone quiet", quiet],
  ] as const;
  if (sections.every(([, lines]) => !lines.length)) return null;
  const message = sections
    .filter(([, lines]) => lines.length)
    .map(
      ([name, lines]) =>
        `${name}\n${lines
          .slice(0, SECTION)
          .map((l) => `• ${l}`)
          .join(
            "\n",
          )}${lines.length > SECTION ? `\n• and ${lines.length - SECTION} more` : ""}`,
    )
    .join("\n\n");
  return {
    title: new Date(`${today}T00:00:00Z`).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }),
    message,
    priority: overdue.length ? 4 : 3,
  };
}

/** Queues today's brief once the brief time has passed, unless it is long past. */
export async function scheduleBrief(
  db: Queryable,
  c: Config,
  now = new Date(),
) {
  if (!c.NTFY_URL) return;
  const { timezone } = (await one(db, "SELECT timezone FROM app_settings"))!;
  const today = localDate(now, timezone);
  const [h, m] = c.BRIEF_TIME.split(":").map(Number) as [number, number];
  const [nh, nm] = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(now)
    .split(":")
    .map(Number) as [number, number];
  const minutes = nh * 60 + nm - (h * 60 + m);
  // A server that was down at brief time doesn't send a stale brief hours later.
  if (minutes < 0 || minutes > 180) return;
  await enqueue(db, "brief", `brief:${today}`, null, { date: today });
}

export async function sendBrief(
  db: Queryable,
  c: Config,
  date: string,
  signal: AbortSignal,
) {
  const { timezone } = (await one(db, "SELECT timezone FROM app_settings"))!;
  const brief = await composeBrief(db, { today: date, timeZone: timezone });
  if (!brief || !c.NTFY_URL) return { sent: false };
  const r = await fetch(c.NTFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(c.NTFY_TOKEN ? { Authorization: `Bearer ${c.NTFY_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      topic: c.NTFY_TOPIC,
      title: brief.title,
      message: brief.message,
      priority: brief.priority,
      click: c.APP_ORIGIN,
    }),
    signal,
  }).catch(() => {
    throw new ProviderError("BRIEF_DELIVERY_FAILED", true);
  });
  // A rejected token or topic needs fixing, not retrying.
  if (!r.ok)
    throw new ProviderError(
      "BRIEF_DELIVERY_FAILED",
      ![401, 403, 404].includes(r.status),
    );
  return { sent: true };
}
