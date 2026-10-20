import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { config } from "@secondbrain/shared";
import { Database, one } from "@secondbrain/database";
import {
  FakeProvider,
  provider,
  ProviderError,
  type AIProvider,
} from "@secondbrain/ai";
import { initStorage } from "@secondbrain/memory";
import { migrate } from "../packages/database/src/migrate.js";
import {
  scenarios as fixtures,
  type Scenario,
} from "../tests/fixtures/agent-scenarios.js";
import { runScenario, summarize } from "./lib/agent-evaluation.js";

type Results = Awaited<ReturnType<typeof runScenario>>[];
/** Every scored check by name, and whether it passed. */
const checks = (results: Results) =>
  new Map<string, boolean>(
    results.flatMap((r) => [
      ...r.ledger.map((l) => [`${r.name}: ${l.expect}`, l.pass] as const),
      ...r.probes.map((p) => [`${r.name}: ${p.question}`, p.pass] as const),
    ]),
  );
/**
 * The deploy gate: on the checks both runs scored, no fewer may pass than in
 * the last accepted run, and no turn may fail.
 */
function gate(results: Results, baseline: Results) {
  const now = checks(results),
    before = checks(baseline);
  const common = [...now.keys()].filter((k) => before.has(k));
  const passed = (m: Map<string, boolean>) =>
    common.filter((k) => m.get(k)).length;
  return {
    pass:
      passed(now) >= passed(before) && !results.some((r) => r.failures.length),
    passedNow: passed(now),
    passedBefore: passed(before),
    of: common.length,
    regressed: common.filter((k) => before.get(k) && !now.get(k)),
    fixed: common.filter((k) => !before.get(k) && now.get(k)),
  };
}

/**
 * Replays synthetic month-long timelines through the real agent pipeline in a
 * dedicated, throwaway database, then asks questions and scores the answers.
 * Only the versioned synthetic fixtures are sent to the provider, plus, when
 * asked for, private cases drafted from the user's own corrections.
 */
try {
  const { values } = parseArgs({
    options: {
      fake: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      "send-synthetic-to-provider": { type: "boolean", default: false },
      database: { type: "string" },
      output: { type: "string", default: "evaluation/results/agent.json" },
      /** Private cases from `pnpm ops corrections --cases`; skipped if missing. */
      cases: { type: "string" },
      "send-cases-to-provider": { type: "boolean", default: false },
      /** The last accepted report: gate on it, and replace it when this run passes. */
      baseline: { type: "string" },
    },
  });
  if (values.fake === values.live)
    throw new Error("Choose exactly one: --fake or --live");
  if (values.live && !values["send-synthetic-to-provider"])
    throw new Error(
      "Live evaluation requires --send-synthetic-to-provider; only the synthetic scenarios are sent.",
    );
  let cases: Scenario[] = [];
  if (values.cases)
    try {
      cases = JSON.parse(await readFile(values.cases, "utf8"));
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  if (values.live && cases.length && !values["send-cases-to-provider"])
    throw new Error(
      "Live evaluation of private cases requires --send-cases-to-provider; they hold your own notes.",
    );
  const scenarios = [...fixtures, ...cases];
  const url = values.database ?? process.env.EVAL_DATABASE_URL;
  if (!url)
    throw new Error("Choose a database with --database or EVAL_DATABASE_URL.");
  const target = new URL(url),
    name = target.pathname.slice(1);
  if (!/eval/.test(name))
    throw new Error(
      "Use a dedicated evaluation database whose name contains 'eval'; it is erased.",
    );
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET ??= "evaluation-only-session-secret-over-32-bytes";
  if (values.fake) process.env.AI_PROVIDER = "fake";
  const c = config();
  if (values.live && !["chatgpt", "openai"].includes(c.AI_PROVIDER))
    throw new Error("Live evaluation requires AI_PROVIDER=chatgpt or openai");
  const ai: AIProvider = values.fake ? new FakeProvider() : provider(c);
  if (!ai.configured)
    throw new Error(
      "Configure and connect the provider before running live evaluation.",
    );
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const server = new Database(admin.toString());
  if (
    !(await one(server, "SELECT 1 FROM pg_database WHERE datname=$1", [name]))
  )
    await server.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  await server.close();
  await migrate(url);
  await initStorage(c);
  const db = new Database(url);
  const results = [];
  try {
    for (const scenario of scenarios) {
      const tables = (
        await db.query(
          `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'`,
        )
      ).rows;
      await db.query(
        "TRUNCATE " +
          tables.map((t) => `"${t.tablename}"`).join(",") +
          " CASCADE",
      );
      await db.query(
        "INSERT INTO app_settings(singleton,cloud_consent_at,timezone) VALUES(true,now(),'Europe/Copenhagen')",
      );
      console.log(`${scenario.name}:`);
      results.push(await runScenario(db, c, ai, scenario, console.log));
    }
  } finally {
    await db.close();
  }
  const summary = summarize(results);
  const report = {
    mode: values.fake ? "fake-agent-harness-check" : "live",
    provider: values.fake ? "fake" : c.AI_PROVIDER,
    model: values.fake ? "fake-agent" : c.REASONING_MODEL,
    timestamp: new Date().toISOString(),
    scope: `${cases.length ? `Synthetic timelines and ${cases.length} private cases from corrections.` : "Synthetic timelines only."} Scores check the ledger and answers against phrase expectations; read the replies too.`,
    summary,
    results,
  };
  const path = resolve(values.output!);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${path}`);
  let previous: Results | null = null;
  if (values.baseline)
    try {
      previous = JSON.parse(await readFile(values.baseline, "utf8")).results;
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  if (previous) {
    const g = gate(results, previous);
    console.log(
      `Gate: ${g.passedNow}/${g.of} checks pass, ${g.passedBefore} in the accepted run.`,
    );
    for (const k of g.regressed) console.log(`  now failing: ${k}`);
    for (const k of g.fixed) console.log(`  now passing: ${k}`);
    if (!g.pass) process.exitCode = 1;
  } else if (values.baseline) {
    // The first gated run sets the bar: every commitment found, no turn failed.
    if (summary.missedCommitments.length || summary.failedTurns.length)
      process.exitCode = 1;
  } else if (
    summary.missedCommitments.length ||
    summary.wronglyListed.length ||
    summary.missingFromAnswers.length ||
    summary.failedTurns.length
  )
    process.exitCode = 1;
  if (values.baseline && !process.exitCode) {
    const target = resolve(values.baseline);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(`Accepted as the new baseline: ${target}`);
  }
} catch (error) {
  // Provider payloads, headers and credentials must not be printed on failure.
  console.error(
    error instanceof ProviderError
      ? `Evaluation failed: ${error.code}`
      : error instanceof Error &&
          /^(Choose|Live evaluation|Use a dedicated|Configure)/.test(
            error.message,
          )
        ? error.message
        : "Evaluation failed. Check configuration, database, output path and provider availability.",
  );
  process.exitCode = 1;
}
