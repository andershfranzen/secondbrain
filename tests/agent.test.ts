import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import argon2 from "argon2";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, one, enqueue } from "@secondbrain/database";
import { migrate } from "../packages/database/src/migrate.js";
import {
  config,
  randomUUID,
  locateQuote,
  type AgentOutput,
} from "@secondbrain/shared";
import {
  FakeProvider,
  ProviderError,
  type AgentRequest,
  type AgentResult,
} from "@secondbrain/ai";
import { buildServer } from "../apps/api/src/server.js";
import {
  processJob,
  claimJob,
  turnTools,
  turnInput,
  postMessage,
  search,
  composeBrief,
  scheduleBrief,
  sendBrief,
  doneLink,
  corrections,
  partialField,
} from "@secondbrain/memory";
import {
  correctionCases,
  scoreLedger,
} from "../scripts/lib/agent-evaluation.js";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:integration-only@127.0.0.1:55432/secondbrain_test";
let db: Database,
  c: ReturnType<typeof config>,
  app: Awaited<ReturnType<typeof buildServer>>,
  dir: string;
const ai = new FakeProvider();
let cookies: Record<string, string> = {};
async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const r = await app.inject({
    method: method as any,
    url: "/api/v1" + path,
    headers: {
      ...headers,
      origin: "http://localhost:3000",
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
      "x-csrf-token": cookies.sb_csrf ?? "",
    },
    ...(body !== undefined ? { payload: body as any } : {}),
  });
  for (const entry of r.cookies) cookies[entry.name] = entry.value;
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
async function login() {
  await request("GET", "/auth/csrf");
  expect(
    (await request("POST", "/auth/login", { password: "agent-password" }))
      .status,
  ).toBe(204);
}
async function drain(adapter = ai) {
  for (let i = 0; i < 80; i++) {
    const job = await one(
      db,
      `SELECT id FROM processing_jobs WHERE status IN('pending','retry_wait') AND run_after<=now() AND blocked_reason IS NULL ORDER BY created_at,id LIMIT 1`,
    );
    if (!job) return;
    await processJob(db, c, adapter, job.id);
  }
  throw new Error("job drain exceeded limit");
}
async function say(text: string, conversationId?: string) {
  const r = await request("POST", "/messages", {
    clientMessageId: randomUUID(),
    text,
    ...(conversationId ? { conversationId } : {}),
  });
  expect(r.status).toBe(202);
  return r.body as {
    messageId: string;
    conversationId: string;
    sourceId: string;
  };
}
async function turn(messageId: string) {
  return (await request("GET", `/messages/${messageId}`)).body;
}
beforeAll(async () => {
  const base = new URL(url),
    name = base.pathname.slice(1);
  if (!/test/.test(name)) throw new Error("Use a dedicated test database");
  base.pathname = "/postgres";
  const admin = new Database(base.toString());
  if (!(await one(admin, "SELECT 1 FROM pg_database WHERE datname=$1", [name])))
    await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  await admin.close();
  await migrate(url);
  dir = await mkdtemp(join(tmpdir(), "secondbrain-agent-"));
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = "an-agent-test-session-secret-over-32-bytes";
  process.env.AI_PROVIDER = "fake";
  process.env.DATA_DIR = dir;
  process.env.ERASURE_MANIFEST_PATH = join(dir, "erasures", "manifest.jsonl");
  process.env.AUTH_PASSWORD_HASH = await argon2.hash("agent-password");
  process.env.LOG_LEVEL = "silent";
  c = config();
  db = new Database(url);
  app = await buildServer(c, db, ai);
});
beforeEach(async () => {
  await app.close();
  app = await buildServer(c, db, ai);
  const tables = (
    await db.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'`,
    )
  ).rows;
  await db.query(
    "TRUNCATE " + tables.map((t) => `"${t.tablename}"`).join(",") + " CASCADE",
  );
  await db.query(
    "INSERT INTO app_settings(singleton,cloud_consent_at) VALUES(true,now())",
  );
  cookies = {};
  await login();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("one composer, one agent turn", () => {
  it("saves and indexes the original before any AI runs, and replays identical message IDs", async () => {
    await db.query("UPDATE app_settings SET cloud_consent_at=NULL");
    const clientMessageId = randomUUID(),
      text = "Forgejo runs on the hallway server.";
    const first = await request("POST", "/messages", { clientMessageId, text });
    expect(first.status).toBe(202);
    const source = await one(
      db,
      "SELECT kind,content FROM sources WHERE id=$1",
      [first.body.sourceId],
    );
    expect(source).toEqual({ kind: "pending", content: text });
    expect(
      (await search(db, ai, "Forgejo", { semantic: false })).items[0]?.sourceId,
    ).toBe(first.body.sourceId);
    await drain();
    expect((await turn(first.body.messageId)).status).toBe("blocked");
    const again = await request("POST", "/messages", { clientMessageId, text });
    expect(again.status).toBe(200);
    expect(again.body.messageId).toBe(first.body.messageId);
    expect(
      (await request("POST", "/messages", { clientMessageId, text: "Other" }))
        .status,
    ).toBe(409);
  });

  it("records a deferred commitment with who asked, and lists it completely a month later", async () => {
    const dump = await say(
      "Mette asked me to build the onboarding dashboard next month, and I said yes.",
    );
    await say("The coffee machine on floor two is broken again.");
    await say("I think Jonas prefers Postgres over MySQL.");
    await drain();
    const saved = await turn(dump.messageId);
    expect(saved.status).toBe("done");
    expect(saved.turn.kind).toBe("note");
    expect(saved.turn.actions).toEqual([
      expect.objectContaining({
        type: "created",
        kind: "task",
        detail: "for Mette, next month",
      }),
    ]);
    const task = await one(db, "SELECT * FROM item_records WHERE kind='task'");
    expect(task).toMatchObject({
      status: "open",
      requested_by: "Mette",
      due_hint: "next month",
      certainty: "confirmed",
      created_by: "worker",
    });
    const evidence = (await one(
      db,
      "SELECT i.*,s.content FROM item_sources i JOIN sources s ON s.id=i.source_id WHERE i.item_id=$1",
      [task!.id],
    ))!;
    expect(
      [...evidence.content]
        .slice(evidence.start_offset, evidence.end_offset)
        .join(""),
    ).toBe(evidence.quote);
    expect(
      (
        await one(
          db,
          "SELECT certainty FROM item_records WHERE title LIKE 'I think Jonas%'",
        )
      )?.certainty,
    ).toBe("unconfirmed");

    const ask = await say("What do I have outstanding?");
    await drain();
    const answer = await turn(ask.messageId);
    expect(answer.turn.kind).toBe("question");
    expect(answer.turn.reply.claims).toEqual([
      expect.objectContaining({
        itemIds: [task!.id],
        citations: [
          expect.objectContaining({
            sourceId: dump.sourceId,
            quote: evidence.quote,
          }),
        ],
      }),
    ]);
    expect(answer.kind).toBe("question");
    // The question never became evidence.
    expect(
      (await one(
        db,
        "SELECT count(*)::int AS n FROM item_sources WHERE source_id=$1",
        [ask.sourceId],
      ))!.n,
    ).toBe(0);
    expect(
      (await search(db, ai, "outstanding", { semantic: false })).items.map(
        (i) => i.sourceId,
      ),
    ).not.toContain(ask.sourceId);
  });

  it("stores a clean rewrite of a rambling dump, with the original kept as evidence", async () => {
    const original =
      "ok so uh Lars asked me to basically set up the staging env for the mobile app thing, lol not this week though.";
    const dump = await say(original);
    await drain();
    expect((await turn(dump.messageId)).status).toBe("done");
    const task = (await one(
      db,
      "SELECT * FROM item_records WHERE kind='task'",
    ))!;
    expect(task.requested_by).toBe("Lars");
    expect(task.title).toBe("Set up the staging env for the mobile app thing");
    expect(task.content).not.toMatch(/\b(uh|basically|lol|ok so)\b/);
    expect(task.content).toMatch(/^Lars asked me to set up the staging env/);
    // The rewrite is the item; the user's words stay untouched as its evidence.
    const evidence = (await one(
      db,
      "SELECT i.quote,s.content FROM item_sources i JOIN sources s ON s.id=i.source_id WHERE i.item_id=$1",
      [task.id],
    ))!;
    expect(evidence.content).toBe(original);
    expect(original).toContain(evidence.quote);
  });

  it("closes the matching commitment when a later note says it is done", async () => {
    await say(
      "Mette asked me to build the onboarding dashboard, I'll do it after the release.",
    );
    await drain();
    const done = await say(
      "I finished the onboarding dashboard for Mette today.",
    );
    await drain();
    const result = await turn(done.messageId);
    expect(result.turn.actions).toEqual([
      expect.objectContaining({ type: "completed", kind: "task" }),
    ]);
    expect(
      await one(
        db,
        "SELECT status,completed_at IS NOT NULL AS closed FROM item_records WHERE kind='task'",
      ),
    ).toEqual({ status: "completed", closed: true });
    const history = (
      await db.query(
        "SELECT event_type,reason FROM memory_events ORDER BY created_at",
      )
    ).rows;
    expect(history.map((h) => h.event_type)).toContain("updated");
    const ask = await say("What do I have outstanding?");
    await drain();
    expect((await turn(ask.messageId)).turn.reply).toMatchObject({
      claims: [],
      text: "You have nothing outstanding.",
    });
  });

  it("keeps one conversation as context and answers follow-ups in place", async () => {
    const first = await say("Forgejo is installed on the home server.");
    await drain();
    const follow = await say(
      "Where is Forgejo installed?",
      first.conversationId,
    );
    await drain();
    const answer = await turn(follow.messageId);
    expect(answer.conversationId).toBe(first.conversationId);
    expect(answer.turn.reply.claims[0].citations[0]).toMatchObject({
      sourceId: first.sourceId,
      quote: "Forgejo is installed on the home server.",
    });
    const conversation = (
      await request("GET", `/conversations/${first.conversationId}`)
    ).body;
    expect(conversation.messages.map((m: any) => [m.role, m.ordinal])).toEqual([
      ["user", 0],
      ["assistant", 1],
      ["user", 2],
      ["assistant", 3],
    ]);
    expect(conversation.turns).toHaveLength(2);
  });

  it("gives the agent each message's local capture time, not the worker's clock", async () => {
    const m = await postMessage(db, {
      clientMessageId: randomUUID(),
      text: "I will check it tomorrow.",
    });
    await db.query(
      "UPDATE messages SET created_at='2026-10-19T23:30:00Z' WHERE id=$1",
      [m.message.id],
    );
    const job = (await one(db, "SELECT * FROM processing_jobs WHERE id=$1", [
      m.job!.id,
    ]))!;
    const { input, current } = await turnInput(db, job);
    expect(current).toEqual([m.source!.id]);
    expect(input.timezone).toBe("Europe/Copenhagen");
    // 23:30 UTC on the 19th is already Tuesday the 20th in Copenhagen.
    expect(input.message.sources[0]!.capturedLocal).toMatch(
      /Tuesday, 20 October 2026 at 01:30/,
    );
    expect(input.hint).toBeNull();
  });
  it("runs turns one at a time, oldest first", async () => {
    const a = await postMessage(db, {
        clientMessageId: randomUUID(),
        text: "First note.",
      }),
      b = await postMessage(db, {
        clientMessageId: randomUUID(),
        text: "Second note.",
      });
    expect(await claimJob(db, b.job!.id, ai)).toBeUndefined();
    expect(await claimJob(db, a.job!.id, ai)).toBeDefined();
    expect(await claimJob(db, b.job!.id, ai)).toBeUndefined();
  });

  it("invalidates replies built on erased notes and keeps the rest", async () => {
    const note = await say("Forgejo is installed on the home server.");
    await drain();
    const ask = await say("Find Forgejo");
    await drain();
    expect((await turn(ask.messageId)).turn.reply.claims).toHaveLength(1);
    expect(
      (
        await request("DELETE", `/conversations/${note.conversationId}`, {
          confirm: true,
        })
      ).status,
    ).toBe(202);
    await drain();
    const after = await turn(ask.messageId);
    expect(after.turn.status).toBe("invalidated");
    expect(after.turn.reply.text).toBe(
      "[Removed because a source was deleted]",
    );
    expect(JSON.stringify(after)).not.toContain("home server");
    expect(
      (await one(
        db,
        "SELECT content FROM messages WHERE role='assistant' AND conversation_id=$1",
        [ask.conversationId],
      ))!.content,
    ).toBe("[Removed because a source was deleted]");
  });

  it("keeps a failed turn's message, reports it and retries on request", async () => {
    class Broken extends FakeProvider {
      override async runAgent<T>(): Promise<AgentResult<T>> {
        throw new ProviderError("PROVIDER_CONFIG", false);
      }
    }
    const m = await say("Remember the router password is on the fridge.");
    await drain(new Broken());
    expect((await turn(m.messageId)).status).toBe("failed");
    expect(
      (await one(db, "SELECT content FROM sources WHERE id=$1", [m.sourceId]))!
        .content,
    ).toContain("router password");
    expect(
      (await request("POST", `/messages/${m.messageId}/retry`)).status,
    ).toBe(202);
    await drain();
    expect((await turn(m.messageId)).status).toBe("done");
  });
});

describe("tool boundary and final-answer checks", () => {
  async function tools(
    text = "Mette asked me to build the onboarding dashboard.",
  ) {
    const m = await postMessage(db, { clientMessageId: randomUUID(), text });
    const job = (await one(db, "SELECT * FROM processing_jobs WHERE id=$1", [
      m.job!.id,
    ]))!;
    const t = turnTools(db, ai, job, [m.source!.id]);
    const run = (name: string, args: unknown) =>
      t.tools
        .find((x) => x.name === name)!
        .run(t.tools.find((x) => x.name === name)!.parameters.parse(args));
    return { ...t, run, source: m.source!.id };
  }
  const create = (
    sourceId: string,
    quote: string,
    extra: Record<string, unknown> = {},
  ) => ({
    kind: "task",
    title: "Onboarding dashboard",
    content: "Build the onboarding dashboard for Mette",
    certainty: "confirmed",
    evidence: [{ sourceId, quote }],
    category: null,
    entityType: null,
    requestedBy: "Mette",
    agreedOn: null,
    startDate: null,
    startTime: null,
    dueDate: null,
    dueTime: null,
    dueHint: null,
    status: null,
    repeat: null,
    projectId: null,
    aliases: null,
    reason: "Commitment",
    ...extra,
  });

  it("locates copied quotes despite whitespace and typographic differences", () => {
    const content = "He said “ship it”  on   Friday.\nThen   left.";
    expect(locateQuote(content, 'said "ship it" on Friday.')).toEqual({
      start: 3,
      end: 31,
      quote: "said “ship it”  on   Friday.",
    });
    expect(locateQuote(content, "something else")).toBeNull();
    expect(locateQuote("🌱 æøå Forgejo", "Forgejo")).toEqual({
      start: 6,
      end: 13,
      quote: "Forgejo",
    });
  });

  it("rejects invented quotes, question sources and unknown items", async () => {
    const t = await tools();
    await expect(
      t.run("create_item", create(t.source, "Mette wants it by Friday")),
    ).rejects.toThrow(/Quote not found/);
    await db.query("UPDATE sources SET kind='question' WHERE id=$1", [
      t.source,
    ]);
    const other = await tools("Something else.");
    await expect(
      other.run("create_item", create(t.source, "Mette asked me")),
    ).rejects.toThrow(/question the user asked/);
    await expect(
      other.run("update_item", {
        id: randomUUID(),
        title: null,
        content: null,
        status: "completed",
        certainty: null,
        requestedBy: null,
        startDate: null,
        startTime: null,
        dueDate: null,
        dueTime: null,
        dueHint: null,
        clearDue: null,
        clearStart: null,
        repeat: null,
        clearRepeat: null,
        projectId: null,
        aliases: null,
        archive: null,
        evidence: [{ sourceId: other.source, quote: "Something else." }],
        reason: "done",
      }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      other.run(
        "create_item",
        create(other.source, "Something else.", { dueDate: "2026-02-30" }),
      ),
    ).rejects.toThrow(/real date/);
    await expect(
      other.run(
        "create_item",
        create(other.source, "Something else.", { dueTime: "14:00" }),
      ),
    ).rejects.toThrow(/dueTime needs dueDate/);
    await expect(
      other.run(
        "create_item",
        create(other.source, "Something else.", {
          startDate: "2026-11-02",
          dueDate: "2026-10-30",
        }),
      ),
    ).rejects.toThrow(/after the deadline/);
    // A pasted sentence is not a title.
    await expect(
      other.run(
        "create_item",
        create(other.source, "Something else.", { title: "word ".repeat(30) }),
      ),
    ).rejects.toThrow(/short label/);
  });

  it("never records a quoted question as confirmed", async () => {
    const t = await tools(
      "Is the dashboard still needed? Mette asked me to build it.",
    );
    const result: any = await t.run(
      "create_item",
      create(t.source, "Is the dashboard still needed?", {
        kind: "memory",
        requestedBy: null,
        category: "context",
      }),
    );
    expect(result.note).toMatch(/unconfirmed/);
    expect((t.plan[0] as any).certainty).toBe("unconfirmed");
  });

  it("sends back a list answer until every listed item is accounted for", async () => {
    const seed = await postMessage(db, {
      clientMessageId: randomUUID(),
      text: "Mette asked me to build the dashboard. Jonas asked me to review the API.",
    });
    await drain();
    const tasks = (
      await db.query(
        "SELECT id FROM knowledge_items WHERE kind='task' ORDER BY created_at",
      )
    ).rows;
    expect(tasks).toHaveLength(2);
    const t = await tools("What do I have outstanding?");
    const listed: any = await t.run("list_items", {
      kinds: ["task", "project"],
      status: "open",
      person: null,
      project: null,
      text: null,
      includeArchived: null,
      forAnswer: true,
    });
    expect(listed.total).toBe(2);
    const quote = (id: string) =>
      one(db, "SELECT source_id,quote FROM item_sources WHERE item_id=$1", [
        id,
      ]);
    const q0 = (await quote(tasks[0]!.id))!;
    const partial: AgentOutput = {
      messageKind: "question",
      reply: "You have one thing outstanding.",
      claims: [
        {
          text: "The dashboard for Mette",
          citations: [{ sourceId: q0.source_id, quote: q0.quote }],
          itemIds: [tasks[0]!.id],
        },
      ],
      accounted: [{ itemId: tasks[0]!.id, included: true, reason: "" }],
      insufficientEvidence: false,
      openListScope: null,
    };
    expect(await t.check(partial)).toMatch(/1 are missing or unexplained: .*/);
    expect(
      await t.check({
        ...partial,
        accounted: [
          ...partial.accounted,
          { itemId: tasks[1]!.id, included: false, reason: "" },
        ],
      }),
    ).toMatch(/missing or unexplained/);
    expect(
      await t.check({
        ...partial,
        accounted: [
          ...partial.accounted,
          { itemId: tasks[1]!.id, included: false, reason: "Not work." },
        ],
      }),
    ).toBeNull();
    expect(
      await t.check({
        ...partial,
        claims: [{ ...partial.claims[0]!, citations: [] }],
      }),
    ).toMatch(/no citation/);
    expect(seed.message.id).toBeDefined();
  });

  it("drives the real loop: a rejected list answer is corrected before anything is shown", async () => {
    await postMessage(db, {
      clientMessageId: randomUUID(),
      text: "Mette asked me to build the dashboard. Jonas asked me to review the API.",
    });
    await drain();
    let attempts = 0;
    class Forgetful extends FakeProvider {
      override async runAgent<T>(
        request: AgentRequest<T>,
      ): Promise<AgentResult<T>> {
        const tool = (name: string) =>
          request.tools.find((t) => t.name === name)!;
        const listed: any = await tool("list_items").run({
          kinds: ["task"],
          status: "open",
          person: null,
          project: null,
          text: null,
          includeArchived: null,
          forAnswer: true,
        });
        for (;;) {
          attempts++;
          const items =
            attempts === 1 ? listed.items.slice(0, 1) : listed.items;
          const claims = [];
          for (const item of items) {
            const full: any = await tool("get_item").run({ id: item.id });
            claims.push({
              text: item.title,
              citations: [
                {
                  sourceId: full.evidence[0].sourceId,
                  quote: full.evidence[0].quote,
                },
              ],
              itemIds: [item.id],
            });
          }
          const value = {
            messageKind: "question",
            reply: `You have ${items.length} open items.`,
            claims,
            accounted: items.map((i: any) => ({
              itemId: i.id,
              included: true,
              reason: "",
            })),
            insufficientEvidence: false,
            openListScope: null,
          } as T;
          const problem = await request.check!(value);
          if (!problem) return { value, steps: [], model: "forgetful" };
          expect(problem).toMatch(/must account for every item/);
        }
      }
    }
    const ask = await say("What do I have outstanding?");
    await drain(new Forgetful());
    expect(attempts).toBe(2);
    expect((await turn(ask.messageId)).turn.reply.claims).toHaveLength(2);
  });
});

describe("calendar", () => {
  const schedule = {
    startDate: null,
    startTime: null,
    dueDate: null,
    dueTime: null,
  };
  /** Plots three commitments the way the agent would, at a fixed "now". */
  class Planner extends FakeProvider {
    override async runAgent<T>(
      request: AgentRequest<T>,
    ): Promise<AgentResult<T>> {
      const input = request.input as any;
      const sourceId = input.message.sources[0].sourceId;
      const create = request.tools.find((t) => t.name === "create_item")!;
      const task = (title: string, quote: string, when: object) =>
        create.run(
          create.parameters.parse({
            kind: "task",
            title,
            content: `${title}.`,
            certainty: "confirmed",
            evidence: [{ sourceId, quote }],
            category: null,
            entityType: null,
            requestedBy: null,
            agreedOn: null,
            ...schedule,
            dueHint: null,
            status: null,
            repeat: null,
            projectId: null,
            aliases: null,
            reason: "Commitment",
            ...when,
          }),
        );
      await task(
        "Update vendor reconciliation",
        "before the run on 30 October",
        {
          dueDate: "2026-10-29",
          dueHint: "before the run on 30 October",
        },
      );
      await task("Set up staging env", "staging env next week", {
        startDate: "2026-10-26",
        dueDate: "2026-11-01",
        dueHint: "next week",
      });
      await task("Meet Jonas", "Thursday 10:00", {
        startDate: "2026-10-22",
        startTime: "10:00",
      });
      const value = {
        messageKind: "note",
        reply: "Saved three commitments.",
        claims: [],
        accounted: [],
        insufficientEvidence: false,
        openListScope: null,
      } as T;
      expect(await request.check!(value)).toBeNull();
      return { value, steps: [], model: "planner" };
    }
  }
  async function plotted() {
    const m = await postMessage(db, {
      clientMessageId: randomUUID(),
      text: "Vendor reconciliation before the run on 30 October. Lars wants the staging env next week. Meeting Jonas Thursday 10:00.",
    });
    await db.query(
      `UPDATE processing_jobs SET payload=payload||'{"now":"2026-10-20T10:00:00Z"}' WHERE id=$1`,
      [m.job!.id],
    );
    await drain(new Planner());
    expect(
      await one(
        db,
        "SELECT status,error_code FROM processing_jobs WHERE id=$1",
        [m.job!.id],
      ),
    ).toEqual({ status: "succeeded", error_code: null });
  }
  async function calendarTool(now: string) {
    const m = await postMessage(db, {
      clientMessageId: randomUUID(),
      text: "What is due next week?",
    });
    await db.query(
      `UPDATE processing_jobs SET payload=payload||jsonb_build_object('now',$2::text) WHERE id=$1`,
      [m.job!.id, now],
    );
    const job = (await one(db, "SELECT * FROM processing_jobs WHERE id=$1", [
      m.job!.id,
    ]))!;
    const t = turnTools(db, ai, job, [m.source!.id]);
    const tool = t.tools.find((x) => x.name === "calendar")!;
    return {
      ...t,
      job,
      run: (args: object) => tool.run(tool.parameters.parse(args)) as any,
    };
  }

  it("stores deadlines, windows and appointments in the user's timezone", async () => {
    await plotted();
    const rows = (
      await db.query(
        `SELECT title,r.due_date,r.due_at,r.start_date,r.start_at,r.due_hint,t.due_source_id IS NOT NULL AS sourced FROM item_records r JOIN tasks t ON t.item_id=r.id ORDER BY title`,
      )
    ).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        title: "Meet Jonas",
        start_date: null,
        // 10:00 in Copenhagen on 22 October (summer time) is 08:00 UTC.
        start_at: new Date("2026-10-22T08:00:00Z"),
        due_date: null,
        sourced: true,
      }),
      expect.objectContaining({
        title: "Set up staging env",
        start_date: "2026-10-26",
        due_date: "2026-11-01",
        due_hint: "next week",
      }),
      expect.objectContaining({
        title: "Update vendor reconciliation",
        due_date: "2026-10-29",
        start_date: null,
      }),
    ]);
  });

  it("gives every turn the coming weeks and the open commitments, soonest deadline first, with quotes", async () => {
    await plotted();
    const { job } = await calendarTool("2026-10-20T10:00:00Z");
    const { input } = await turnInput(db, job);
    expect(input.calendar.today).toBe("2026-10-20 (Tuesday, week 43)");
    expect(input.calendar.weeks[0]).toBe(
      "Week 43: Mon 19 Oct – Sun 25 Oct 2026",
    );
    expect(input.calendar.weeks[1]).toMatch(/^Week 44: Mon 26 Oct/);
    expect(input.open.complete).toBe(true);
    expect(input.open.items.map((a) => [a.title, a.start, a.due])).toEqual([
      ["Update vendor reconciliation", null, "2026-10-29"],
      ["Set up staging env", "2026-10-26", "2026-11-01"],
      ["Meet Jonas", "2026-10-22 10:00", null],
    ]);
    expect(input.open.items[0]!.quotes).toEqual([
      expect.objectContaining({ quote: "before the run on 30 October" }),
    ]);
  });

  it("answers from the open list in one step, still accounting for every match", async () => {
    await plotted();
    const ask = await say("What's due by Friday?");
    let attempts = 0;
    class OneStep extends FakeProvider {
      override async runAgent<T>(
        request: AgentRequest<T>,
      ): Promise<AgentResult<T>> {
        const open = (request.input as any).open.items;
        for (;;) {
          attempts++;
          // The first answer forgets the staging window that ends on Sunday 1 Nov.
          const due = open.filter(
            (i: any) =>
              i.due && i.due <= (attempts === 1 ? "2026-10-30" : "2026-11-01"),
          );
          const value = {
            messageKind: "question",
            reply: `${due.length} due.`,
            claims: due.map((i: any) => ({
              text: i.title,
              citations: i.quotes,
              itemIds: [i.id],
            })),
            accounted: [],
            insufficientEvidence: false,
            openListScope: {
              kinds: ["task"],
              person: null,
              dueBy: "2026-11-01",
            },
          } as T;
          const problem = await request.check!(value);
          if (!problem) return { value, steps: [], model: "one-step" };
          expect(problem).toMatch(/1 are missing/);
        }
      }
    }
    await db.query(
      `UPDATE processing_jobs SET payload=payload||'{"now":"2026-10-20T10:00:00Z"}' WHERE kind='converse' AND status='pending'`,
    );
    await drain(new OneStep());
    expect(attempts).toBe(2);
    expect(
      (await turn(ask.messageId)).turn.reply.claims.map((c: any) => c.text),
    ).toEqual(["Update vendor reconciliation", "Set up staging env"]);
  });

  it("lays out a range by day, flags overdue work, and makes the agent account for it", async () => {
    await plotted();
    const next = await calendarTool("2026-10-20T10:00:00Z");
    const week: any = await next.run({
      from: "2026-10-26",
      to: "2026-11-01",
      forAnswer: true,
    });
    expect(
      week.days.map((d: any) => [
        d.date,
        d.entries.map((e: any) => `${e.event} ${e.title}`),
      ]),
    ).toEqual([
      ["2026-10-26", ["starts Set up staging env"]],
      ["2026-10-29", ["due Update vendor reconciliation"]],
      ["2026-11-01", ["due Set up staging env"]],
    ]);
    expect(week.days[0].week).toBe(44);
    expect(week.overdue).toEqual([]);
    expect(week.items.map((i: any) => i.title).sort()).toEqual([
      "Set up staging env",
      "Update vendor reconciliation",
    ]);
    // Leaving a listed item out of the answer is sent back.
    const answer: AgentOutput = {
      messageKind: "question",
      reply: "One thing is due.",
      claims: [],
      accounted: [],
      insufficientEvidence: false,
      openListScope: null,
    };
    expect(await next.check(answer)).toMatch(/2 are missing/);

    // A week after the reconciliation deadline, it is overdue in every range from today.
    const later = await calendarTool("2026-11-03T09:00:00Z");
    const today: any = await later.run({
      from: null,
      to: null,
      forAnswer: false,
    });
    expect(today.from).toBe("2026-11-03");
    expect(today.to).toBe("2026-11-16");
    expect(
      today.overdue.map(
        (id: string) => today.items.find((i: any) => i.id === id).title,
      ),
    ).toEqual(["Update vendor reconciliation", "Set up staging env"]);
  });

  it("writes a morning brief from the calendar, and nothing on a quiet day", async () => {
    await plotted();
    const tz = { timeZone: "Europe/Copenhagen" };
    expect(await composeBrief(db, { today: "2026-10-22", ...tz })).toEqual({
      title: "Thursday 22 October",
      message: [
        "Today",
        "• Meet Jonas at 10:00",
        "",
        "This week",
        "• Set up staging env (starts Mon 26 Oct)",
      ].join("\n"),
      priority: 3,
      done: [
        {
          id: expect.any(String),
          title: "Meet Jonas",
          revision: expect.any(Number),
        },
      ],
    });
    // The coming six days: the reconciliation deadline on the 29th appears from the 23rd.
    expect(
      (await composeBrief(db, { today: "2026-10-23", ...tz }))!.message,
    ).toMatch(/• Update vendor reconciliation \(due Thu 29 Oct\)/);
    // A missed deadline goes first and raises the priority.
    const late = (await composeBrief(db, { today: "2026-10-30", ...tz }))!;
    expect(late.message).toMatch(
      /^Overdue\n• Update vendor reconciliation \(due Thu 29 Oct\)\n\nThis week\n• Set up staging env \(due Sun 1 Nov\)/,
    );
    expect(late.priority).toBe(4);
    // A deadline that hasn't come up for weeks is flagged.
    await db.query(
      "UPDATE tasks SET last_mentioned_at='2026-09-01' WHERE action LIKE 'Set up staging%'",
    );
    expect(
      (await composeBrief(db, { today: "2026-10-27", ...tz }))!.message,
    ).toMatch(/Gone quiet\n• Set up staging env \(due Sun 1 Nov\)$/);
    await db.query("UPDATE tasks SET status='completed',completed_at=now()");
    expect(await composeBrief(db, { today: "2026-10-27", ...tz })).toBeNull();
  });

  it("queues the brief once, shortly after brief time, and posts it to ntfy", async () => {
    await plotted();
    const ntfy = { ...c, NTFY_URL: "http://ntfy.test/", NTFY_TOKEN: "tk_test" };
    await scheduleBrief(db, c, new Date("2026-10-22T05:45:00Z"));
    expect(
      await one(db, "SELECT 1 FROM processing_jobs WHERE kind='brief'"),
    ).toBeUndefined();
    // 07:45 in Copenhagen: due. 14:00: too late to be useful, skipped.
    await scheduleBrief(db, ntfy, new Date("2026-10-22T12:00:00Z"));
    await scheduleBrief(db, ntfy, new Date("2026-10-22T05:45:00Z"));
    await scheduleBrief(db, ntfy, new Date("2026-10-22T06:15:00Z"));
    expect(
      (
        await db.query(
          "SELECT dedupe_key,payload FROM processing_jobs WHERE kind='brief'",
        )
      ).rows,
    ).toEqual([
      { dedupe_key: "brief:2026-10-22", payload: { date: "2026-10-22" } },
    ]);
    const sent: any[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: init.headers,
        body: JSON.parse(String(init.body)),
      });
      return new Response("{}", { status: 200 });
    }) as any;
    try {
      expect(
        await sendBrief(db, ntfy, "2026-10-22", AbortSignal.timeout(5000)),
      ).toEqual({ sent: true });
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toEqual([
      {
        url: "http://ntfy.test/",
        headers: expect.objectContaining({ Authorization: "Bearer tk_test" }),
        body: expect.objectContaining({
          topic: "second-brain",
          title: "Thursday 22 October",
          priority: 3,
          click: c.APP_ORIGIN,
          message: expect.stringContaining("Meet Jonas at 10:00"),
          actions: [
            {
              action: "http",
              label: "Done: Meet Jonas",
              url: expect.stringMatching(
                /^http:\/\/localhost:3000\/api\/v1\/brief\/done\/[0-9a-f-]{36}\?r=\d+&e=\d+&s=[\w-]+$/,
              ),
              method: "POST",
              clear: true,
            },
          ],
        }),
      },
    ]);
  });

  it("completes a task from the brief's signed link, once", async () => {
    await plotted();
    const meet = (await one(
      db,
      "SELECT id,revision FROM knowledge_items WHERE title='Meet Jonas'",
    )) as { id: string; revision: number };
    const link = new URL(doneLink(c, meet));
    const tap = (url: URL) =>
      app.inject({ method: "POST", url: url.pathname + url.search });
    // The notification app sends no session, cookie or origin.
    const done = await tap(link);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ title: "Meet Jonas", status: "completed" });
    expect(
      await one(db, "SELECT status FROM tasks WHERE item_id=$1", [meet.id]),
    ).toEqual({ status: "completed" });
    expect((await tap(link)).statusCode).toBe(409);
    const forged = new URL(link);
    forged.searchParams.set("r", String(meet.revision + 1));
    expect((await tap(forged)).statusCode).toBe(403);
    const expired = new URL(
      doneLink(c, meet, new Date(Date.now() - 37 * 3600 * 1000)),
    );
    expect((await tap(expired)).statusCode).toBe(403);
    // Other routes still need a session.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/turns/" + meet.id + "/undo",
        })
      ).statusCode,
    ).toBe(403);
  });

  it("moves, times and clears a task's dates", async () => {
    await plotted();
    const ic = (await one(
      db,
      "SELECT id FROM knowledge_items WHERE title='Update vendor reconciliation'",
    ))!;
    const m = await postMessage(db, {
      clientMessageId: randomUUID(),
      text: "Birgit moved the reconciliation deadline to 5 November at 12:00.",
    });
    class Mover extends FakeProvider {
      override async runAgent<T>(
        request: AgentRequest<T>,
      ): Promise<AgentResult<T>> {
        const update = request.tools.find((t) => t.name === "update_item")!;
        const args = {
          id: ic.id,
          title: null,
          content: null,
          status: null,
          certainty: null,
          requestedBy: null,
          ...schedule,
          dueHint: null,
          clearDue: null,
          clearStart: null,
          repeat: null,
          clearRepeat: null,
          projectId: null,
          aliases: null,
          archive: null,
          evidence: [
            {
              sourceId: m.source!.id,
              quote: "moved the reconciliation deadline to 5 November at 12:00",
            },
          ],
          reason: "Deadline moved",
        };
        await expect(
          update.run(
            update.parameters.parse({ ...args, startDate: "2026-11-09" }),
          ),
        ).rejects.toThrow(/after the deadline/);
        await update.run(
          update.parameters.parse({
            ...args,
            dueDate: "2026-11-05",
            dueTime: "12:00",
            dueHint: "5 November at 12:00",
          }),
        );
        const value = {
          messageKind: "instruction",
          reply: "Moved.",
          claims: [],
          accounted: [],
          insufficientEvidence: false,
          openListScope: null,
        } as T;
        expect(await request.check!(value)).toBeNull();
        return { value, steps: [], model: "mover" };
      }
    }
    await drain(new Mover());
    expect(
      await one(
        db,
        "SELECT due_date,due_at,due_hint FROM tasks WHERE item_id=$1",
        [ic.id],
      ),
    ).toEqual({
      due_date: null,
      // Winter time from 25 October: 12:00 in Copenhagen is 11:00 UTC.
      due_at: new Date("2026-11-05T11:00:00Z"),
      due_hint: "5 November at 12:00",
    });
  });
});

describe("undo", () => {
  const taskState = () =>
    one(
      db,
      "SELECT r.id,r.status,r.completed_at,(SELECT count(*)::int FROM item_sources WHERE item_id=r.id) AS links FROM item_records r WHERE r.kind='task'",
    );
  it("takes back what a message changed, latest first, never over a later change", async () => {
    const first = await say(
      "Mette asked me to build the onboarding dashboard.",
    );
    await drain();
    const made = (await turn(first.messageId)).turn;
    expect(made.canUndo).toBe(true);
    expect(await taskState()).toMatchObject({ status: "open", links: 1 });

    const done = await say("I finished the onboarding dashboard for Mette.");
    await drain();
    const closed = (await turn(done.messageId)).turn;
    expect(await taskState()).toMatchObject({ status: "completed", links: 2 });

    // The later message changed the task, so the first one can't be undone yet.
    const blocked = await request("POST", `/turns/${made.id}/undo`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(
      /Changed since: .*onboarding dashboard/i,
    );

    expect((await request("POST", `/turns/${closed.id}/undo`)).status).toBe(
      200,
    );
    expect(await taskState()).toMatchObject({
      status: "open",
      completed_at: null,
      links: 1,
    });
    const after = (await turn(done.messageId)).turn;
    expect(after).toMatchObject({ status: "undone", canUndo: false });
    expect((await request("POST", `/turns/${closed.id}/undo`)).status).toBe(
      409,
    );
    // Follow-up turns see that it was taken back.
    expect(
      (await one(
        db,
        "SELECT content FROM messages WHERE role='assistant' AND origin_key=$1",
        [
          `reply:${(await one(db, "SELECT job_id FROM agent_turns WHERE id=$1", [closed.id]))!.job_id}`,
        ],
      ))!.content,
    ).toMatch(/^\[Undone by the user\]/);

    // With the later change gone, the first message can be undone too.
    expect((await request("POST", `/turns/${made.id}/undo`)).status).toBe(200);
    expect(await taskState()).toBeUndefined();
    // Both notes stay as they were written.
    expect(
      (
        await db.query(
          "SELECT content FROM messages WHERE role='user' ORDER BY created_at",
        )
      ).rows.map((m) => m.content),
    ).toEqual([
      "Mette asked me to build the onboarding dashboard.",
      "I finished the onboarding dashboard for Mette.",
    ]);
  });

  it("has nothing to undo for a question, and forgets snapshots of erased text", async () => {
    const note = await say("Jonas asked me to review the API design.");
    await drain();
    const ask = await say("What do I have outstanding?");
    await drain();
    expect((await turn(ask.messageId)).turn.canUndo).toBe(false);
    const made = (await turn(note.messageId)).turn;
    expect(made.canUndo).toBe(true);
    // Another conversation closes the task; its snapshot holds the first note's wording.
    const done = await say("I finished the API design review for Jonas.");
    await drain();
    expect((await turn(done.messageId)).turn.canUndo).toBe(true);
    const { conversationId } = note;
    expect(
      (
        await request("DELETE", `/conversations/${conversationId}`, {
          confirm: true,
        })
      ).status,
    ).toBeLessThan(300);
    await drain();
    expect(
      await one(
        db,
        "SELECT count(*)::int AS n FROM agent_turns WHERE undo IS NOT NULL",
      ),
    ).toEqual({ n: 0 });
  });
});

describe("worker wake-up", () => {
  it("signals once per new job, never when a recurring job is re-enqueued", async () => {
    const client = await db.pool.connect();
    const got: string[] = [];
    client.on("notification", (n) => got.push(n.channel));
    await client.query("LISTEN processing_jobs");
    try {
      await enqueue(db, "retention", "retention:wake-test", null);
      // The worker re-enqueues this every pass; a signal here would loop forever.
      await enqueue(db, "retention", "retention:wake-test", null);
      await new Promise((r) => setTimeout(r, 300));
      expect(got).toEqual(["processing_jobs"]);
    } finally {
      await client.query("UNLISTEN *");
      client.release();
    }
  });
});

/** A scripted agent turn: drives the real tools, then answers. */
class Scripted extends FakeProvider {
  constructor(
    private script: (
      run: (name: string, args: object) => Promise<any>,
      input: any,
      request: AgentRequest<any>,
    ) => Promise<Partial<AgentOutput> | void>,
  ) {
    super();
  }
  override async runAgent<T>(
    request: AgentRequest<T>,
  ): Promise<AgentResult<T>> {
    const run = (name: string, args: object) => {
      const t = request.tools.find((x) => x.name === name)!;
      return t.run(t.parameters.parse(args));
    };
    const extra = await this.script(run, request.input, request as any);
    const value = {
      messageKind: "note",
      reply: "Saved.",
      claims: [],
      accounted: [],
      insufficientEvidence: false,
      openListScope: null,
      ...extra,
    } as T;
    expect(await request.check!(value)).toBeNull();
    return { value, steps: [], model: "scripted" };
  }
}
const noSchedule = {
  startDate: null,
  startTime: null,
  dueDate: null,
  dueTime: null,
};
const createTask = (sourceId: string, quote: string, extra: object) => ({
  kind: "task",
  title: "Send the cost report",
  content: "Send the monthly cost report.",
  certainty: "confirmed",
  evidence: [{ sourceId, quote }],
  category: null,
  entityType: null,
  requestedBy: null,
  agreedOn: null,
  ...noSchedule,
  dueHint: null,
  status: null,
  repeat: null,
  projectId: null,
  aliases: null,
  reason: "Commitment",
  ...extra,
});
const updateTask = (
  id: string,
  sourceId: string,
  quote: string,
  extra: object,
) => ({
  id,
  title: null,
  content: null,
  status: null,
  certainty: null,
  requestedBy: null,
  ...noSchedule,
  dueHint: null,
  clearDue: null,
  clearStart: null,
  repeat: null,
  clearRepeat: null,
  projectId: null,
  aliases: null,
  archive: null,
  evidence: [{ sourceId, quote }],
  reason: "Update",
  ...extra,
});
async function note(text: string, now: string, adapter: FakeProvider) {
  const m = await postMessage(db, { clientMessageId: randomUUID(), text });
  await db.query(
    `UPDATE processing_jobs SET payload=payload||jsonb_build_object('now',$2::text) WHERE id=$1`,
    [m.job!.id, now],
  );
  await drain(adapter);
  expect(
    await one(db, "SELECT status,error_code FROM processing_jobs WHERE id=$1", [
      m.job!.id,
    ]),
  ).toEqual({ status: "succeeded", error_code: null });
  return m;
}

describe("repeating commitments", () => {
  async function monthly(title = "Send the cost report") {
    await note(
      "I send the cost report every month-end.",
      "2026-10-20T10:00:00Z",
      new Scripted(async (run, input) => {
        const sourceId = input.message.sources[0].sourceId;
        await expect(
          run(
            "create_item",
            createTask(sourceId, "every month-end", {
              title,
              repeat: { every: "month", interval: 1 },
            }),
          ),
        ).rejects.toThrow(/needs the date of its next occurrence/);
        await run(
          "create_item",
          createTask(sourceId, "every month-end", {
            title,
            dueDate: "2026-10-31",
            dueHint: "every month-end",
            repeat: { every: "month", interval: 1 },
          }),
        );
      }),
    );
    return (await one(db, "SELECT id FROM knowledge_items WHERE title=$1", [
      title,
    ]))!.id as string;
  }
  const state = (id: string) =>
    one(
      db,
      "SELECT status,due_date,completed_at,last_done_at IS NOT NULL AS done_before,repeat_every,repeat_interval,repeat_anchor FROM tasks WHERE item_id=$1",
      [id],
    );

  it("moves on to the next occurrence when one is done, and shows later ones on the calendar", async () => {
    const id = await monthly();
    expect(await state(id)).toEqual({
      status: "open",
      due_date: "2026-10-31",
      completed_at: null,
      done_before: false,
      repeat_every: "month",
      repeat_interval: 1,
      repeat_anchor: "2026-10-31",
    });
    const m = await note(
      "Sent the October cost report.",
      "2026-10-30T10:00:00Z",
      new Scripted(async (run, input) => {
        const sourceId = input.message.sources[0].sourceId;
        expect(input.open.items[0]).toMatchObject({
          title: "Send the cost report",
          repeats: "every month",
          lastDone: null,
        });
        await run(
          "update_item",
          updateTask(id, sourceId, "Sent the October cost report", {
            status: "completed",
          }),
        );
      }),
    );
    expect(await state(id)).toMatchObject({
      status: "open",
      due_date: "2026-11-30",
      completed_at: null,
      done_before: true,
    });
    const actions = (await one(
      db,
      "SELECT t.actions FROM agent_turns t JOIN processing_jobs j ON j.id=t.job_id WHERE j.id=$1",
      [m.job!.id],
    ))!.actions;
    expect(actions).toEqual([
      expect.objectContaining({ type: "completed", detail: "next 2026-11-30" }),
    ]);
    // Ticking it off by hand moves it on as well, keeping the month's end.
    const item = (await request("GET", `/items/${id}`)).body;
    const patched = await request(
      "PATCH",
      `/items/${id}`,
      { status: "completed" },
      { "if-match": `"${item.revision}"` },
    );
    expect(patched.status).toBe(200);
    expect(await state(id)).toMatchObject({
      status: "open",
      due_date: "2026-12-31",
    });
    // Later occurrences sit on the calendar too.
    const ask = await postMessage(db, {
      clientMessageId: randomUUID(),
      text: "What is due through February?",
    });
    const job = (await one(db, "SELECT * FROM processing_jobs WHERE id=$1", [
      ask.job!.id,
    ]))!;
    const t = turnTools(db, ai, job, [ask.source!.id], {
      clock: { timeZone: "Europe/Copenhagen", today: "2026-11-02" },
    });
    const cal = t.tools.find((x) => x.name === "calendar")!;
    const r: any = await cal.run(
      cal.parameters.parse({
        from: "2026-12-01",
        to: "2027-02-28",
        forAnswer: true,
      }),
    );
    expect(
      r.days.map((d: any) => [d.date, d.entries.map((e: any) => e.event)]),
    ).toEqual([
      ["2026-12-31", ["due"]],
      ["2027-01-31", ["repeats"]],
      ["2027-02-28", ["repeats"]],
    ]);
  });

  it("ends the series when cancelled, or turns it into a one-off", async () => {
    const id = await monthly();
    await note(
      "Finance takes over the cost report, so I no longer send it.",
      "2026-10-21T10:00:00Z",
      new Scripted(async (run, input) => {
        const sourceId = input.message.sources[0].sourceId;
        await run(
          "update_item",
          updateTask(id, sourceId, "I no longer send it", {
            status: "cancelled",
          }),
        );
      }),
    );
    expect(await state(id)).toMatchObject({
      status: "cancelled",
      due_date: "2026-10-31",
    });
    const other = await monthly("Send the yearly cost report");
    await note(
      "The cost report is a one-off this year after all.",
      "2026-10-21T11:00:00Z",
      new Scripted(async (run, input) => {
        const sourceId = input.message.sources[0].sourceId;
        await run(
          "update_item",
          updateTask(other, sourceId, "a one-off this year", {
            clearRepeat: true,
          }),
        );
      }),
    );
    expect(await state(other)).toMatchObject({
      repeat_every: null,
      repeat_anchor: null,
    });
  });
});

describe("streaming progress", () => {
  it("shows what the turn is doing, then a question's answer as it is written", async () => {
    await login();
    const asked = await say("What do I have outstanding?");
    const pause = () => new Promise((r) => setTimeout(r, 400));
    const seen: any[] = [];
    await drain(
      new Scripted(async (_run, _input, request) => {
        request.onProgress!({ type: "tool", tool: "calendar" });
        await pause();
        seen.push((await turn(asked.messageId)) as any);
        request.onProgress!({
          type: "text",
          text: '{"messageKind":"question","reply":"Nothing open \\"yet',
        });
        await pause();
        seen.push((await turn(asked.messageId)) as any);
        return {
          messageKind: "question",
          reply: 'Nothing open "yet".',
          insufficientEvidence: true,
        };
      }),
    );
    expect(seen.map((s) => [s.status, s.progress])).toEqual([
      ["working", { activity: "Checking the calendar", reply: null }],
      ["working", { activity: "Writing", reply: 'Nothing open "yet' }],
    ]);
    const done = await turn(asked.messageId);
    expect(done).toMatchObject({ status: "done", progress: null });
    expect(done.turn.reply.text).toBe('Nothing open "yet".');
  });

  it("reads a field from a partly written JSON answer", () => {
    const full = JSON.stringify({
      messageKind: "question",
      reply: 'Two "open":\n- **one** é \u2713',
    });
    expect(partialField(full.slice(0, 20), "reply")).toBeNull();
    expect(partialField(full.slice(0, full.indexOf("open") + 2), "reply")).toBe(
      'Two "op',
    );
    expect(partialField(full, "reply")).toBe('Two "open":\n- **one** é ✓');
    expect(partialField(full, "messageKind")).toBe("question");
    // A half-written escape is left out until it completes.
    expect(partialField('{"reply":"a\\', "reply")).toBe("a");
  });
});

describe("corrections", () => {
  it("collects undone turns and the user's edits to what the agent recorded, as private cases", async () => {
    const made = await say("Mette asked me to build the onboarding dashboard.");
    await drain();
    const doc = await say("Jonas asked me to review the API design doc.");
    await drain();
    const undone = (await turn(made.messageId)).turn;
    expect((await request("POST", `/turns/${undone.id}/undo`)).status).toBe(
      200,
    );
    // The user fixes who asked and the deadline on the second one.
    const review = (await one(
      db,
      "SELECT id,revision FROM knowledge_items WHERE kind='task'",
    ))!;
    expect(
      (
        await request(
          "PATCH",
          `/items/${review.id}`,
          { dueDate: "2026-11-06", title: "Review Jonas's API design doc" },
          { "if-match": `"${review.revision}"` },
        )
      ).status,
    ).toBe(200);
    // Ticking something off is progress, not a correction.
    const item = (await request("GET", `/items/${review.id}`)).body;
    await request(
      "PATCH",
      `/items/${review.id}`,
      { status: "completed" },
      { "if-match": `"${item.revision}"` },
    );
    const list = await corrections(db, new Date(Date.now() - 3600000));
    expect(list).toEqual([
      expect.objectContaining({
        kind: "undo",
        messageKind: "note",
        notes: [
          expect.objectContaining({
            text: "Mette asked me to build the onboarding dashboard.",
          }),
        ],
        undid: [expect.objectContaining({ type: "created", kind: "task" })],
      }),
      expect.objectContaining({
        kind: "edit",
        itemKind: "task",
        changed: ["title", "due"],
        notes: [
          expect.objectContaining({
            text: "Jonas asked me to review the API design doc.",
          }),
        ],
        after: expect.objectContaining({ due: "2026-11-06" }),
      }),
    ]);
    const cases = correctionCases(list);
    expect(cases.map((x) => x.ledger)).toEqual([
      [expect.objectContaining({ status: "absent", commitment: false })],
      [
        expect.objectContaining({
          phrases: expect.arrayContaining(["jonas", "review", "design"]),
          status: "open",
          due: ["2026-11-06"],
        }),
      ],
    ]);
    expect(cases[1]!.steps).toEqual([
      expect.objectContaining({
        text: "Jonas asked me to review the API design doc.",
      }),
    ]);
  });

  it("scores something that must not become a task", () => {
    const task = {
      id: "x",
      kind: "task",
      title: "Build the onboarding dashboard",
      content: "",
      status: "open",
      requestedBy: null,
      certainty: "confirmed",
      quotes: [],
      start: null,
      due: null,
      dueHint: null,
    };
    const check = {
      phrases: ["onboarding"],
      status: "absent" as const,
      commitment: false,
    };
    expect(scoreLedger([task], [check])[0]).toMatchObject({
      pass: false,
      problems: ["recorded as a task"],
    });
    expect(scoreLedger([], [check])[0]!.pass).toBe(true);
  });
});
