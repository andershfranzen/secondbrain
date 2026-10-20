import type { Queryable, Row } from "@secondbrain/database";

/**
 * The calendar the agent plans against. Days are calendar dates (YYYY-MM-DD)
 * in the user's timezone; a task sits between its start and its deadline.
 */
export const isoDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const isoTime = (value: string) =>
  /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** The calendar date of an instant in a timezone. */
export function localDate(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
/** "YYYY-MM-DD HH:MM" for a timed instant, the date alone otherwise. */
export function localStamp(
  date: string | null,
  at: Date | string | null,
  timeZone: string,
) {
  if (date) return date;
  if (!at) return null;
  const instant = new Date(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return `${localDate(instant, timeZone)} ${time}`;
}
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
export function addDays(iso: string, days: number) {
  const d = day(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (from: string, to: string) =>
  Math.round((day(to).getTime() - day(from).getTime()) / 86400000);
/** Monday of the ISO week containing the date. */
export const weekStart = (iso: string) =>
  addDays(iso, -((day(iso).getUTCDay() + 6) % 7));
export function isoWeek(iso: string) {
  const thursday = addDays(weekStart(iso), 3);
  const firstThursday = addDays(weekStart(`${thursday.slice(0, 4)}-01-04`), 3);
  return daysBetween(firstThursday, thursday) / 7 + 1;
}
export const weekday = (iso: string) =>
  day(iso).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
const short = (iso: string) =>
  day(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** The current and coming weeks, for resolving "next week", "uge 44" or "end of the month". */
export function upcomingWeeks(today: string, count = 8) {
  const monday = weekStart(today);
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(monday, i * 7),
      end = addDays(start, 6);
    return `Week ${isoWeek(start)}: ${short(start)} – ${short(end)} ${end.slice(0, 4)}`;
  });
}

/** The day a task starts and is due, in the user's timezone, as SQL. */
const startDay = (tz: string) =>
  `coalesce(r.start_date,(r.start_at AT TIME ZONE ${tz})::date)`;
const dueDay = (tz: string) =>
  `coalesce(r.due_date,(r.due_at AT TIME ZONE ${tz})::date)`;

export type AgendaTask = Row & {
  start_day: string | null;
  due_day: string | null;
};
/**
 * Open tasks on the calendar between two days: overdue ones, ones that start
 * or are due in the range, ones whose window spans it, and (for a range from
 * today) started ones without a deadline. Undated open tasks are listed
 * separately so loose commitments are never invisible.
 */
export async function agenda(
  db: Queryable,
  {
    from,
    to,
    today,
    timeZone,
  }: { from: string; to: string; today: string; timeZone: string },
  limit = 400,
) {
  const open = `r.kind='task' AND r.status IN('open','in_progress') AND r.lifecycle='active' AND r.projection_state='valid'`;
  const rows = (
    await db.query<AgendaTask>(
      `SELECT r.*,${startDay("$4")}::text AS start_day,${dueDay("$4")}::text AS due_day,
        (SELECT title FROM knowledge_items p WHERE p.id=r.project_id) AS project_title,
        (SELECT max(m.created_at) FROM item_sources i JOIN sources s ON s.id=i.source_id JOIN messages m ON m.id=s.message_id WHERE i.item_id=r.id AND s.available) AS last_source_at
       FROM item_records r
       WHERE ${open} AND (
         ${dueDay("$4")} < $3::date
         OR ${dueDay("$4")} BETWEEN $1::date AND $2::date
         OR ${startDay("$4")} BETWEEN $1::date AND $2::date
         OR (${startDay("$4")} < $1::date AND ${dueDay("$4")} > $2::date)
         OR (${startDay("$4")} < $1::date AND ${dueDay("$4")} IS NULL AND $1::date <= $3::date)
       )
       ORDER BY coalesce(${dueDay("$4")},${startDay("$4")}), r.due_at NULLS FIRST, r.id
       LIMIT ${limit + 1}`,
      [from, to, today, timeZone],
    )
  ).rows;
  const undated = (
    await db.query(
      `SELECT r.id,r.title,r.due_hint,count(*) OVER() AS total FROM item_records r
       WHERE ${open} AND r.due_date IS NULL AND r.due_at IS NULL AND r.start_date IS NULL AND r.start_at IS NULL
       ORDER BY r.updated_at DESC,r.id LIMIT 30`,
    )
  ).rows;
  return {
    truncated: rows.length > limit,
    tasks: rows.slice(0, limit),
    undated: {
      total: undated.length ? Number(undated[0]!.total) : 0,
      items: undated.map((u) => ({
        id: u.id as string,
        title: u.title as string,
        dueHint: (u.due_hint as string | null) ?? null,
      })),
    },
  };
}
