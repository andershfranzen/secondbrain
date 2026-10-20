import { type Queryable, type Row, one } from "@secondbrain/database";

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

export type Repeat = {
  every: "day" | "week" | "month" | "year";
  interval: number;
};
const lastDay = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
/**
 * The nth occurrence of a series counted from its anchor day. A month-end
 * anchor stays at the month's end; day 31 falls back to shorter months' last day.
 */
export function occurrence(anchor: string, repeat: Repeat, n: number) {
  const step = n * repeat.interval;
  if (repeat.every === "day") return addDays(anchor, step);
  if (repeat.every === "week") return addDays(anchor, step * 7);
  const a = day(anchor),
    months = a.getUTCMonth() + step * (repeat.every === "year" ? 12 : 1),
    year = a.getUTCFullYear() + Math.floor(months / 12),
    month = ((months % 12) + 12) % 12,
    monthEnd = a.getUTCDate() === lastDay(a.getUTCFullYear(), a.getUTCMonth()),
    date = monthEnd
      ? lastDay(year, month)
      : Math.min(a.getUTCDate(), lastDay(year, month));
  return new Date(Date.UTC(year, month, date)).toISOString().slice(0, 10);
}
/** The first occurrence after a day. */
export function nextOccurrence(anchor: string, repeat: Repeat, after: string) {
  const days = { day: 1, week: 7, month: 28, year: 365 }[repeat.every];
  let n = Math.max(
    0,
    Math.floor(daysBetween(anchor, after) / (days * repeat.interval)) - 1,
  );
  while (occurrence(anchor, repeat, n) <= after) n++;
  return occurrence(anchor, repeat, n);
}
/**
 * Completing a repeating task moves it on to its next occurrence instead of
 * closing it: start and deadline shift by the same number of days, keeping
 * their local times. Returns the new deadline (or start), or null when the
 * task does not repeat.
 */
export async function rollRepeat(tx: Queryable, id: string) {
  const t = await one(
    tx,
    `SELECT t.status,t.repeat_every,t.repeat_interval,t.repeat_anchor,s.timezone,
       coalesce(t.due_date,(t.due_at AT TIME ZONE s.timezone)::date)::text AS due_day,
       coalesce(t.start_date,(t.start_at AT TIME ZONE s.timezone)::date)::text AS start_day
     FROM tasks t, app_settings s WHERE t.item_id=$1`,
    [id],
  );
  if (!t?.repeat_every || t.status !== "completed") return null;
  const ref: string | null = t.due_day ?? t.start_day;
  if (!ref) return null;
  const next = nextOccurrence(
    t.repeat_anchor,
    { every: t.repeat_every, interval: t.repeat_interval },
    ref,
  );
  const shift = daysBetween(ref, next);
  const moved = (column: string) =>
    `((${column} AT TIME ZONE $3)+make_interval(days=>$2)) AT TIME ZONE $3`;
  const r = (await one(
    tx,
    `UPDATE tasks SET status='open',last_done_at=completed_at,completed_at=NULL,
       due_date=due_date+$2::int,due_at=${moved("due_at")},
       start_date=start_date+$2::int,start_at=${moved("start_at")}
     WHERE item_id=$1 RETURNING due_date,due_at,start_date,start_at`,
    [id, shift, t.timezone],
  ))!;
  return t.due_day
    ? localStamp(r.due_date, r.due_at, t.timezone)
    : localStamp(r.start_date, r.start_at, t.timezone);
}
/** "every month", "every 2 weeks". */
export const repeatLabel = (r: Repeat) =>
  r.interval === 1 ? `every ${r.every}` : `every ${r.interval} ${r.every}s`;

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
  const columns = (tz: string) =>
    `r.*,${startDay(tz)}::text AS start_day,${dueDay(tz)}::text AS due_day,
     (SELECT title FROM knowledge_items p WHERE p.id=r.project_id) AS project_title,
     (SELECT max(m.created_at) FROM item_sources i JOIN sources s ON s.id=i.source_id JOIN messages m ON m.id=s.message_id WHERE i.item_id=r.id AND s.available) AS last_source_at`;
  const rows = (
    await db.query<AgendaTask>(
      `SELECT ${columns("$4")}
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
  // Repeating tasks show their next occurrence; later ones in the range come from the rule.
  const repeating = (
    await db.query(
      `SELECT r.id,r.title,r.repeat_every,r.repeat_interval,r.repeat_anchor,
         coalesce(${dueDay("$1")},${startDay("$1")})::text AS ref
       FROM item_records r WHERE ${open} AND r.repeat_every IS NOT NULL`,
      [timeZone],
    )
  ).rows;
  const later: { id: string; title: string; date: string }[] = [];
  for (const r of repeating) {
    const rule: Repeat = { every: r.repeat_every, interval: r.repeat_interval };
    for (
      let date = nextOccurrence(r.repeat_anchor, rule, r.ref), n = 0;
      date <= to && n < 31;
      date = nextOccurrence(r.repeat_anchor, rule, date), n++
    )
      if (date >= from) later.push({ id: r.id, title: r.title, date });
  }
  const tasks = rows.slice(0, limit);
  const missing = [...new Set(later.map((l) => l.id))].filter(
    (id) => !tasks.some((t) => t.id === id),
  );
  if (missing.length)
    tasks.push(
      ...(
        await db.query<AgendaTask>(
          `SELECT ${columns("$2")} FROM item_records r WHERE r.id=ANY($1::uuid[]) ORDER BY r.id`,
          [missing, timeZone],
        )
      ).rows,
    );
  return {
    truncated: rows.length > limit,
    tasks,
    /** Later occurrences of repeating tasks within the range. */
    later: later.sort((a, b) => a.date.localeCompare(b.date)),
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
