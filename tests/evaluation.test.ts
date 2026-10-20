import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, one } from "@secondbrain/database";
import { config } from "@secondbrain/shared";
import { FakeProvider } from "@secondbrain/ai";
import { migrate } from "../packages/database/src/migrate.js";
import { scenarios } from "./fixtures/agent-scenarios.js";
import {
  runScenario,
  scoreLedger,
  scoreProbe,
  summarize,
  type LedgerItem,
} from "../scripts/lib/agent-evaluation.js";

const task = (over: Partial<LedgerItem>): LedgerItem => ({
  id: "x",
  kind: "task",
  title: "",
  content: "",
  status: "open",
  requestedBy: null,
  certainty: "confirmed",
  quotes: [],
  start: null,
  due: null,
  dueHint: null,
  ...over,
});
describe("agent evaluation scoring", () => {
  it("checks deadlines, starts and undated timing on the calendar", () => {
    const [due, start, undated] = scoreLedger(
      [
        task({ title: "Update vendor reconciliation", due: "2026-10-30" }),
        task({ title: "Meet Sofie", start: "2026-10-08 10:00" }),
        task({
          title: "Release notes",
          due: "2026-11-30",
          dueHint: "when the release is out",
        }),
      ],
      [
        {
          phrases: ["vendor reconciliation"],
          status: "open",
          commitment: true,
          due: ["2026-11-05", "2026-11-06"],
        },
        {
          phrases: ["Sofie"],
          status: "open",
          commitment: false,
          start: ["2026-10-08 10:00"],
        },
        {
          phrases: ["release notes"],
          status: "open",
          commitment: true,
          undated: true,
        },
      ],
    );
    expect(due!.problems).toEqual([
      "due 2026-10-30, expected 2026-11-05 or 2026-11-06",
    ]);
    expect(start!.pass).toBe(true);
    expect(undated!.problems[0]).toMatch(/expected no dates/);
  });
  it("has stable scenarios whose expectations name real phrases in their notes", () => {
    for (const s of scenarios) {
      const text = s.steps
        .map((x) => x.text)
        .join("\n")
        .toLowerCase();
      for (const check of s.ledger)
        expect(check.phrases.some((p) => text.includes(p.toLowerCase()))).toBe(
          true,
        );
      for (const probe of s.probes)
        for (const group of probe.mustInclude)
          expect(group.some((p) => text.includes(p.toLowerCase()))).toBe(true);
      expect(s.steps.map((x) => x.at)).toEqual(
        [...s.steps.map((x) => x.at)].sort(),
      );
    }
  });
  it("flags a missed commitment, a wrong status, a wrong requester and lost uncertainty", () => {
    const checks = [
      {
        phrases: ["dashboard"],
        status: "open" as const,
        requestedBy: "Mette",
        commitment: true,
      },
      { phrases: ["venue"], status: "closed" as const, commitment: true },
      {
        phrases: ["mentor"],
        status: "open" as const,
        certainty: "unconfirmed" as const,
        commitment: true,
      },
      { phrases: ["wiki"], status: "open" as const, commitment: true },
    ];
    const scored = scoreLedger(
      [
        task({ title: "Onboarding dashboard", requestedBy: "Jonas" }),
        task({ title: "Book venue", status: "open" }),
        task({ title: "Mentor the intern", certainty: "confirmed" }),
      ],
      checks,
    );
    expect(scored.map((s) => s.pass)).toEqual([false, false, false, false]);
    expect(scored[0]!.problems[0]).toMatch(/asked by Jonas, expected Mette/);
    expect(scored[1]!.problems).toContain("status is open");
    expect(scored[2]!.problems[0]).toMatch(/certainty is confirmed/);
    expect(scored[3]!.problems).toEqual(["not recorded as a task"]);
    expect(
      scoreLedger(
        [task({ title: "Book venue", status: "cancelled" })],
        [checks[1]!],
      )[0]!.pass,
    ).toBe(true);
  });
  it("fails a commitment whose title or content kept the user's filler, but not its quotes", () => {
    const check = {
      phrases: ["staging"],
      status: "open" as const,
      commitment: true,
      filler: ["uh", "lol", "was like"],
    };
    const quotes = [
      "ok so uh Lars asked if I could set up the staging env, lol",
    ];
    const [messy] = scoreLedger(
      [
        task({
          title: "Set up staging env",
          content: "Lars was like, set up the staging env lol",
          quotes,
        }),
      ],
      [check],
    );
    expect(messy!.problems).toEqual(["filler kept in the item: lol, was like"]);
    const [clean] = scoreLedger(
      [
        task({
          title: "Set up the staging environment for the mobile app",
          content:
            "Lars asked me to set it up; not this week. Thursday is fine.",
          quotes,
        }),
      ],
      [check],
    );
    expect(clean!.pass).toBe(true);
  });
  it("requires every expected item in an answer and nothing excluded among its citations", () => {
    const probe = {
      at: "",
      question: "What do I have outstanding?",
      mustInclude: [["dashboard"], ["wiki"]],
      mustExclude: [["venue"]],
    };
    const answer = (
      claims: { text: string; quotes: string[]; items: LedgerItem[] }[],
    ) => ({
      question: probe.question,
      status: "done",
      reply: "Here is what is open. The venue booking was cancelled.",
      claims,
    });
    expect(
      scoreProbe(
        answer([
          {
            text: "Dashboard for Mette",
            quotes: ["build the onboarding dashboard"],
            items: [],
          },
          {
            text: "Update the wiki",
            quotes: ["opdatere wiki-siden"],
            items: [],
          },
        ]),
        probe,
      ).pass,
    ).toBe(true);
    const wrong = scoreProbe(
      answer([
        { text: "Dashboard", quotes: [], items: [] },
        { text: "Book a venue", quotes: ["I need to book a venue"], items: [] },
      ]),
      probe,
    );
    expect(wrong.missed).toEqual(["wiki"]);
    expect(wrong.violations).toEqual(["venue"]);
  });
});

describe("agent evaluation harness", () => {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres:integration-only@127.0.0.1:55432/secondbrain_test";
  let db: Database, dir: string;
  beforeAll(async () => {
    await migrate(url);
    dir = await mkdtemp(join(tmpdir(), "secondbrain-eval-"));
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET = "an-evaluation-test-secret-over-32-bytes";
    process.env.DATA_DIR = dir;
    process.env.AI_PROVIDER = "fake";
    db = new Database(url);
  });
  afterAll(async () => {
    await db?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it("replays a dated timeline through the real pipeline and scores the result", async () => {
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
    const result = await runScenario(
      db,
      config(),
      new FakeProvider(),
      scenarios[0]!,
    );
    expect(result.failures).toEqual([]);
    // The fake agent is a crude stand-in; it handles this phrasing and not all.
    const mette = result.ledger.find((l) =>
      l.expect.startsWith("onboarding dashboard"),
    )!;
    expect(mette.pass).toBe(true);
    expect(
      (await one(
        db,
        "SELECT created_at FROM messages WHERE content LIKE 'Standup notes%'",
      ))!.created_at.toISOString(),
    ).toBe("2026-09-01T07:10:00.000Z");
    const summary = summarize([result]);
    expect(summary.answersPassed).toMatch(/^\d+\/4$/);
    expect(summary.missedCommitments).not.toContain(
      "onboarding dashboard (open)",
    );
  });
});
