import { type Database, one } from "@secondbrain/database";
import type { AIProvider } from "@secondbrain/ai";
import { type Config, randomUUID } from "@secondbrain/shared";
import { postMessage, processJob, type Correction } from "@secondbrain/memory";
import type {
  LedgerCheck,
  Phrases,
  Probe,
  Scenario,
} from "../../tests/fixtures/agent-scenarios.js";

export type LedgerItem = {
  id: string;
  kind: string;
  title: string;
  content: string;
  status: string | null;
  requestedBy: string | null;
  certainty: string;
  quotes: string[];
  /** Calendar placement in the user's timezone: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM". */
  start: string | null;
  due: string | null;
  dueHint: string | null;
  /** day, week, month or year for a repeating task. */
  repeat?: string | null;
};
export type ProbeAnswer = {
  question: string;
  status: string;
  reply: string;
  claims: { text: string; quotes: string[]; items: LedgerItem[] }[];
};
const matches = (text: string, phrases: Phrases) =>
  phrases.some((p) => text.toLowerCase().includes(p.toLowerCase()));
const itemText = (i: LedgerItem) =>
  [i.title, i.content, ...i.quotes].join("\n");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Filler words found in what the agent wrote (not in the quoted evidence). */
const fillerIn = (i: LedgerItem, filler: Phrases) =>
  filler.filter((f) =>
    new RegExp(`(^|[^\\p{L}])${escape(f)}($|[^\\p{L}])`, "iu").test(
      `${i.title}\n${i.content}`,
    ),
  );

/** Scores the ledger: the right commitments, open or closed, with who asked. */
export function scoreLedger(items: LedgerItem[], checks: LedgerCheck[]) {
  return checks.map((check) => {
    const found = items.filter(
      (i) => i.kind === "task" && matches(itemText(i), check.phrases),
    );
    const wanted = found.filter((i) =>
      check.status === "open"
        ? ["open", "in_progress"].includes(i.status ?? "")
        : ["completed", "cancelled"].includes(i.status ?? ""),
    );
    // A closed commitment fails if any matching task is still listed as open.
    const stillOpen =
      check.status === "closed" &&
      found.some((i) => ["open", "in_progress"].includes(i.status ?? ""));
    if (check.status === "absent")
      return {
        expect: `${check.phrases[0]} (absent)`,
        commitment: check.commitment,
        pass: !found.length,
        problems: found.length ? ["recorded as a task"] : [],
        items: found.map((i) => ({
          title: i.title,
          status: i.status,
          requestedBy: i.requestedBy,
          start: i.start,
          due: i.due,
          dueHint: i.dueHint,
        })),
      };
    const problems = [
      !found.length && "not recorded as a task",
      found.length &&
        !wanted.length &&
        `status is ${found.map((i) => i.status).join(", ")}`,
      stillOpen && "a duplicate is still open",
      check.requestedBy &&
        wanted.length &&
        !wanted.some((i) =>
          i.requestedBy
            ?.toLowerCase()
            .includes(check.requestedBy!.toLowerCase()),
        ) &&
        `asked by ${wanted.map((i) => i.requestedBy ?? "nobody").join(", ")}, expected ${check.requestedBy}`,
      check.certainty &&
        wanted.length &&
        !wanted.some((i) => i.certainty === check.certainty) &&
        `certainty is ${wanted.map((i) => i.certainty).join(", ")}`,
      check.due &&
        wanted.length &&
        !wanted.some((i) => check.due!.includes(i.due?.slice(0, 10) ?? "")) &&
        `due ${wanted.map((i) => i.due ?? "none").join(", ")}, expected ${check.due.join(" or ")}`,
      check.start &&
        wanted.length &&
        !wanted.some((i) => check.start!.includes(i.start ?? "")) &&
        `starts ${wanted.map((i) => i.start ?? "none").join(", ")}, expected ${check.start.join(" or ")}`,
      check.undated &&
        wanted.length &&
        !wanted.some((i) => !i.due && !i.start && i.dueHint) &&
        `expected no dates and the timing in dueHint; got ${wanted.map((i) => `${i.start ?? "-"}..${i.due ?? "-"} (${i.dueHint ?? "no hint"})`).join(", ")}`,
      check.repeats &&
        wanted.length &&
        !wanted.some((i) => i.repeat === check.repeats) &&
        `repeats ${wanted.map((i) => i.repeat ?? "never").join(", ")}, expected every ${check.repeats}`,
      ...wanted
        .map((i) => fillerIn(i, check.filler ?? []))
        .filter((f) => f.length)
        .map((f) => `filler kept in the item: ${f.join(", ")}`),
    ].filter(Boolean) as string[];
    return {
      expect: `${check.phrases[0]} (${check.status})`,
      commitment: check.commitment,
      pass: !problems.length,
      problems,
      items: found.map((i) => ({
        title: i.title,
        status: i.status,
        requestedBy: i.requestedBy,
        start: i.start,
        due: i.due,
        dueHint: i.dueHint,
      })),
    };
  });
}
/** Scores one answer: every expected group present, nothing excluded cited. */
export function scoreProbe(answer: ProbeAnswer, probe: Probe) {
  const said = [
    answer.reply,
    ...answer.claims.flatMap((c) => [
      c.text,
      ...c.quotes,
      ...c.items.map(itemText),
    ]),
  ].join("\n");
  // Exclusions look only at evidence and cited items: the reply may mention
  // that something is done without listing it as outstanding.
  const cited = answer.claims
    .flatMap((c) => [...c.quotes, ...c.items.map(itemText)])
    .join("\n");
  const missed = probe.mustInclude
    .filter((g) => !matches(said, g))
    .map((g) => g[0]!);
  const violations = probe.mustExclude
    .filter((g) => matches(cited, g))
    .map((g) => g[0]!);
  return {
    question: probe.question,
    status: answer.status,
    pass: answer.status === "done" && !missed.length && !violations.length,
    missed,
    violations,
    reply: answer.reply,
    claims: answer.claims.map((c) => c.text),
  };
}

async function process(db: Database, c: Config, ai: AIProvider, jobId: string) {
  // Retryable provider failures are retried at once; evaluation has no time to wait.
  for (let attempt = 0; attempt < 4; attempt++) {
    await db.query(
      "UPDATE processing_jobs SET run_after=now() WHERE id=$1 AND status IN('pending','retry_wait')",
      [jobId],
    );
    await processJob(db, c, ai, jobId);
    const job = (await one(
      db,
      "SELECT status FROM processing_jobs WHERE id=$1",
      [jobId],
    ))!;
    if (job.status === "succeeded" || job.status === "failed")
      return job.status as string;
  }
  return "failed";
}
async function say(
  db: Database,
  c: Config,
  ai: AIProvider,
  text: string,
  at: string,
) {
  const m = await postMessage(db, { clientMessageId: randomUUID(), text });
  await db.query("UPDATE messages SET created_at=$2 WHERE id=$1", [
    m.message.id,
    at,
  ]);
  await db.query("UPDATE conversations SET created_at=$2 WHERE id=$1", [
    m.message.conversation_id,
    at,
  ]);
  await db.query(
    "UPDATE processing_jobs SET payload=payload||jsonb_build_object('now',$2::text) WHERE id=$1",
    [m.job!.id, new Date(at).toISOString()],
  );
  const status = await process(db, c, ai, m.job!.id);
  // Embed new text too, so semantic search is evaluated where it exists.
  for (const job of (
    await db.query(
      "SELECT id FROM processing_jobs WHERE kind='embed' AND status='pending' AND blocked_reason IS NULL ORDER BY created_at",
    )
  ).rows)
    await processJob(db, c, ai, job.id);
  return { message: m.message, jobId: m.job!.id as string, status };
}
async function ledger(db: Database): Promise<LedgerItem[]> {
  return (
    await db.query(
      `SELECT r.id,r.kind,r.title,r.content,r.status,r.requested_by AS "requestedBy",r.certainty,
        coalesce((SELECT array_agg(i.quote) FROM item_sources i WHERE i.item_id=r.id),'{}') AS quotes,
        coalesce(r.start_date::text,to_char(r.start_at AT TIME ZONE s.timezone,'YYYY-MM-DD HH24:MI')) AS start,
        coalesce(r.due_date::text,to_char(r.due_at AT TIME ZONE s.timezone,'YYYY-MM-DD HH24:MI')) AS due,
        r.due_hint AS "dueHint",r.repeat_every AS repeat
       FROM item_records r, app_settings s WHERE r.projection_state='valid' AND r.lifecycle<>'superseded'`,
    )
  ).rows as LedgerItem[];
}
export async function runScenario(
  db: Database,
  c: Config,
  ai: AIProvider,
  scenario: Scenario,
  log: (line: string) => void = () => {},
) {
  const failures: string[] = [];
  for (const step of scenario.steps) {
    const r = await say(db, c, ai, step.text, step.at);
    log(`  ${step.at.slice(0, 10)} note → ${r.status}`);
    if (r.status !== "succeeded")
      failures.push(`Turn failed for: ${step.text}`);
  }
  const items = await ledger(db);
  const ledgerChecks = scoreLedger(items, scenario.ledger);
  const probes = [];
  for (const probe of scenario.probes) {
    const r = await say(db, c, ai, probe.question, probe.at);
    const turn = await one(
      db,
      "SELECT reply FROM agent_turns WHERE job_id=$1",
      [r.jobId],
    );
    const byId = new Map((await ledger(db)).map((i) => [i.id, i]));
    const answer: ProbeAnswer = {
      question: probe.question,
      status: r.status === "succeeded" ? "done" : r.status,
      reply: turn?.reply.text ?? "",
      claims: (turn?.reply.claims ?? []).map((cl: any) => ({
        text: cl.text,
        quotes: cl.citations.map((x: any) => x.quote),
        items: cl.itemIds.flatMap((id: string) =>
          byId.has(id) ? [byId.get(id)!] : [],
        ),
      })),
    };
    const scored = scoreProbe(answer, probe);
    log(
      `  ? ${probe.question} → ${scored.pass ? "pass" : `missed ${scored.missed.join(", ") || "-"}; wrong ${scored.violations.join(", ") || "-"}`}`,
    );
    probes.push(scored);
  }
  return { name: scenario.name, failures, ledger: ledgerChecks, probes };
}
const significant = (s: string) =>
  new Set(s.toLowerCase().match(/[\p{L}\p{N}]{5,}/gu) ?? []);
/** Words of an item's title that also occur in the notes, to find it again. */
function phrasesFor(title: string, notes: string) {
  const inNotes = significant(notes);
  const words = [...significant(title)];
  const shared = words.filter((w) => inNotes.has(w));
  return (shared.length ? shared : words).slice(0, 4);
}
/**
 * Draft evaluation cases from the user's corrections: replay the notes the
 * agent got wrong and expect what the user corrected it to. They hold the
 * user's own notes, so they stay private (next to the data, never in Git).
 * Corrections that depend on earlier state (an undone update) are skipped.
 */
export function correctionCases(list: Correction[]): Scenario[] {
  const cases: Scenario[] = [];
  for (const c of list) {
    if (!c.notes.length) continue;
    const text = c.notes.map((n) => n.text).join("\n");
    const steps = c.notes.map((n) => ({ at: n.at, text: n.text }));
    let ledger: LedgerCheck[] = [];
    if (c.kind === "undo" && c.messageKind !== "question")
      ledger = c.undid
        .filter((a) => a.type === "created" && a.kind === "task")
        .map((a) => ({
          phrases: phrasesFor(a.title, text),
          status: "absent",
          commitment: false,
        }));
    if (c.kind === "edit" && c.itemKind === "task") {
      const a = c.after;
      ledger = [
        {
          phrases: phrasesFor(a.title, text),
          status:
            a.lifecycle === "archived"
              ? "absent"
              : ["completed", "cancelled"].includes(a.status ?? "")
                ? "closed"
                : "open",
          commitment: true,
          ...(c.changed.includes("requestedBy") && a.requestedBy
            ? { requestedBy: a.requestedBy }
            : {}),
          ...(c.changed.includes("due") && a.due
            ? { due: [a.due.slice(0, 10)] }
            : {}),
          ...(c.changed.includes("start") && a.start
            ? { start: [a.start] }
            : {}),
        },
      ];
    }
    if (ledger.some((l) => l.phrases.length))
      cases.push({
        name: `correction-${c.at.slice(0, 10)}-${(c.kind === "undo" ? c.turnId : c.itemId).slice(0, 8)}`,
        steps,
        ledger: ledger.filter((l) => l.phrases.length),
        probes: [],
      });
  }
  return cases;
}
export function summarize(results: Awaited<ReturnType<typeof runScenario>>[]) {
  const checks = results.flatMap((r) => r.ledger),
    probes = results.flatMap((r) => r.probes);
  return {
    missedCommitments: checks
      .filter((c) => c.commitment && !c.pass)
      .map((c) => c.expect),
    ledgerPassed: `${checks.filter((c) => c.pass).length}/${checks.length}`,
    answersPassed: `${probes.filter((p) => p.pass).length}/${probes.length}`,
    missingFromAnswers: probes.flatMap((p) =>
      p.missed.map((m) => `${p.question}: ${m}`),
    ),
    wronglyListed: probes.flatMap((p) =>
      p.violations.map((v) => `${p.question}: ${v}`),
    ),
    failedTurns: results.flatMap((r) => r.failures),
  };
}
