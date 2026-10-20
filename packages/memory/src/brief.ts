import { createHmac, timingSafeEqual } from "node:crypto";
import { type Queryable, one, enqueue } from "@secondbrain/database";
import { type Config } from "@secondbrain/shared";
import { ProviderError } from "@secondbrain/ai";
import { agenda, addDays, localDate } from "./calendar.js";

/**
 * The morning brief: one push a day from the calendar, built from the ledger
 * without a model. Quiet days send nothing.
 */
export type Brief = {
  title: string;
  message: string;
  priority: number;
  /** The most urgent tasks, most urgent first, for "Done" buttons. */
  done: { id: string; title: string; revision: number }[];
};

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
  const urgent: [number, (typeof tasks)[number]][] = [];
  for (const r of tasks) {
    const due = r.due_day,
      starts = r.start_day;
    if (due && due < today) {
      overdue.push(`${r.title} (due ${day(due)}${who(r)})`);
      urgent.push([0, r]);
    } else if (due === today) {
      now.push(
        `${r.title} (due today${r.due_at ? ` ${time(r.due_at, timeZone)}` : ""}${who(r)})`,
      );
      urgent.push([1, r]);
    } else if (starts === today) {
      now.push(
        `${r.title}${r.start_at ? ` at ${time(r.start_at, timeZone)}` : " (starts today)"}`,
      );
      urgent.push([2, r]);
    } else if (due && due <= week) {
      soon.push(`${r.title} (due ${day(due)}${who(r)})`);
      urgent.push([3, r]);
    } else if (starts && starts > today && starts <= week)
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
    done: urgent
      .sort((a, b) => a[0] - b[0])
      .slice(0, 3)
      .map(([, r]) => ({ id: r.id, title: r.title, revision: r.revision })),
  };
}

/**
 * A "Done" button in the brief is a signed link for one task at one revision:
 * it works once, since completing the task changes its revision, and expires.
 */
const doneSignature = (
  c: Config,
  id: string,
  revision: number,
  expires: number,
) =>
  createHmac("sha256", c.SESSION_SECRET)
    .update(`brief-done:${id}:${revision}:${expires}`)
    .digest("base64url");
export function doneLink(
  c: Config,
  task: { id: string; revision: number },
  now = new Date(),
) {
  const expires = Math.floor(now.getTime() / 1000) + 36 * 3600;
  const query = new URLSearchParams({
    r: String(task.revision),
    e: String(expires),
    s: doneSignature(c, task.id, task.revision, expires),
  });
  return `${c.APP_ORIGIN}/api/v1/brief/done/${task.id}?${query}`;
}
/** The revision a valid, unexpired link was signed for, or null. */
export function verifyDoneLink(
  c: Config,
  id: string,
  query: { r?: string; e?: string; s?: string },
  now = new Date(),
) {
  const revision = Number(query.r),
    expires = Number(query.e);
  if (!Number.isInteger(revision) || !Number.isInteger(expires) || !query.s)
    return null;
  if (expires < now.getTime() / 1000) return null;
  const expected = Buffer.from(doneSignature(c, id, revision, expires)),
    given = Buffer.from(query.s);
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? revision
    : null;
}
const label = (title: string) =>
  `Done: ${[...title].length > 24 ? [...title].slice(0, 23).join("").trimEnd() + "…" : title}`;

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
      // ntfy shows at most three buttons; each completes one task.
      actions: brief.done.map((task) => ({
        action: "http",
        label: label(task.title),
        url: doneLink(c, task),
        method: "POST",
        clear: true,
      })),
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
