import "dotenv/config";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";

export const uuid = z.uuid();
export const kinds = ["memory", "project", "task", "idea", "entity"] as const;
export const relations = [
  "related_to",
  "part_of",
  "precedes",
  "depends_on",
  "mentions",
] as const;
export const Evidence = z.strictObject({
  sourceId: uuid,
  start: z.int().nonnegative(),
  end: z.int().positive(),
  quote: z.string().min(1),
});
const base = {
  localId: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(10000),
  epistemicState: z.enum(["confirmed", "uncertain", "proposed"]),
  confidence: z.number().min(0).max(1),
  commitment: z.enum(["explicit", "suggested", "none"]),
  due: z
    .union([
      z.strictObject({
        type: z.literal("date"),
        value: z.iso.date(),
        evidence: Evidence,
      }),
      z.strictObject({
        type: z.literal("instant"),
        value: z.iso.datetime({ offset: true }),
        evidence: Evidence,
      }),
    ])
    .nullable(),
  evidence: z.array(Evidence).min(1).max(30),
};
export const Candidate = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    kind: z.literal("memory"),
    category: z.enum(["fact", "preference", "decision", "context"]),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("project"),
    outcome: z.string().nullable(),
    currentState: z.string().nullable(),
    lastDecision: z.string().nullable(),
    blocker: z.string().nullable(),
    nextStep: z.string().nullable(),
  }),
  z.strictObject({ ...base, kind: z.literal("task") }),
  z.strictObject({ ...base, kind: z.literal("idea") }),
  z.strictObject({
    ...base,
    kind: z.literal("entity"),
    entityType: z.enum([
      "person",
      "product",
      "organization",
      "place",
      "concept",
    ]),
  }),
]);
export type Candidate = z.infer<typeof Candidate>;
export type Evidence = z.infer<typeof Evidence>;
export const MessageInput = z.strictObject({
  clientMessageId: uuid,
  text: z
    .string()
    .min(1)
    .refine((t) => t.trim().length > 0, "Write something first")
    .refine((t) => [...t].length <= 100000, "Maximum 100,000 characters"),
  conversationId: uuid.optional(),
});
export const messageKinds = [
  "note",
  "question",
  "mixed",
  "instruction",
] as const;
export const certainties = ["confirmed", "unconfirmed"] as const;
// The model-facing contract avoids length keywords that strict tool schemas may
// reject; limits are enforced after parsing and returned to the agent to fix.
const AgentQuote = z.strictObject({ sourceId: z.string(), quote: z.string() });
export const AgentOutput = z.strictObject({
  messageKind: z.enum(messageKinds),
  reply: z.string(),
  claims: z.array(
    z.strictObject({
      text: z.string(),
      citations: z.array(AgentQuote),
      itemIds: z.array(z.string()),
    }),
  ),
  accounted: z.array(
    z.strictObject({
      itemId: z.string(),
      included: z.boolean(),
      reason: z.string(),
    }),
  ),
  insufficientEvidence: z.boolean(),
  /**
   * Set when the answer lists open commitments straight from the turn's open
   * list: the filter it applied. Code reruns it and requires every match to
   * be accounted for, as with a forAnswer listing.
   */
  openListScope: z
    .strictObject({
      kinds: z.array(z.enum(["task", "project"])).nullable(),
      person: z.string().nullable(),
      dueBy: z.string().nullable(),
    })
    .nullable(),
});
export type AgentOutput = z.infer<typeof AgentOutput>;
/** Everything the agent receives at the start of a turn; tools supply the rest. */
export type ConverseInput = {
  now: string;
  timezone: string;
  today: string;
  /** "note" when the client saved this explicitly as a capture or recording. */
  hint: "note" | null;
  message: {
    sources: {
      sourceId: string;
      text: string;
      capturedAt: string;
      capturedLocal: string;
    }[];
  };
  conversation: { role: "user" | "assistant"; text: string; at: string }[];
  ledger: {
    openTasks: number;
    activeProjects: number;
    people: number;
    notes: number;
  };
  /** The calendar to plan against: today and the coming weeks. */
  calendar: { today: string; weeks: string[] };
  /** Open tasks and active projects, most urgent first, ready to answer from. */
  open: {
    complete: boolean;
    total: number;
    items: {
      id: string;
      kind: "task" | "project";
      title: string;
      content: string | null;
      certainty: string;
      status: string | null;
      requestedBy: string | null;
      start: string | null;
      due: string | null;
      dueHint: string | null;
      /** A repeating task: "every month", and the day it was last done. */
      repeats?: string;
      lastDone?: string | null;
      overdue: boolean;
      quotes: { sourceId: string; quote: string }[];
    }[];
  };
};
/** What the client renders for one turn. Citations are resolved and verified. */
export type TurnReply = {
  text: string;
  claims: {
    text: string;
    citations: {
      sourceId: string;
      start: number;
      end: number;
      quote: string;
    }[];
    itemIds: string[];
  }[];
  insufficientEvidence: boolean;
};
export type TurnAction = {
  type:
    | "created"
    | "updated"
    | "completed"
    | "cancelled"
    | "reopened"
    | "linked"
    | "archived";
  itemId: string;
  kind: string;
  title: string;
  certainty: "confirmed" | "unconfirmed";
  detail: string | null;
};
export const TextCapture = z.strictObject({
  clientCaptureId: uuid,
  text: z
    .string()
    .min(1)
    .refine((t) => [...t].length <= 100000, "Maximum 100,000 characters"),
});
export const ManualItem = z.strictObject({
  kind: z.enum(kinds),
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(10000),
  projectId: uuid.nullable().optional(),
  category: z.enum(["fact", "preference", "decision", "context"]).optional(),
  entityType: z
    .enum(["person", "product", "organization", "place", "concept"])
    .optional(),
});
export const ItemPatch = z.strictObject({
  aliases: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().trim().min(1).max(10000).optional(),
  lifecycle: z.enum(["active", "archived"]).optional(),
  status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional(),
  outcome: z.string().max(10000).nullable().optional(),
  currentState: z.string().max(10000).nullable().optional(),
  lastDecision: z.string().max(10000).nullable().optional(),
  blocker: z.string().max(10000).nullable().optional(),
  nextStep: z.string().max(10000).nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const normalize = (s: string) =>
  s.trim().replace(/\s+/g, " ").toLowerCase();
export const slice = (s: string, start: number, end: number) =>
  [...s].slice(start, end).join("");
export const operationId = (s: string) => {
  const h = hash(s);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export { randomUUID, z };
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new AppError(status, code, message);
}
export function config() {
  const c = z
    .object({
      NODE_ENV: z.string().default("development"),
      DATABASE_URL: z.string().min(1),
      REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
      APP_ORIGIN: z.url().default("http://localhost:3000"),
      DATA_DIR: z.string().default("./data"),
      ERASURE_MANIFEST_PATH: z.string().default("./erasures/manifest.jsonl"),
      RESTIC_REPOSITORY: z.string().optional(),
      RESTIC_PASSWORD_FILE: z.string().optional(),
      SESSION_SECRET: z.string().min(32),
      AUTH_PASSWORD_HASH: z.string().optional(),
      AI_PROVIDER: z
        .enum(["none", "openai", "chatgpt", "fake"])
        .default("none"),
      CHATGPT_CREDENTIALS_PATH: z.string().default("./secrets/chatgpt.json"),
      AI_API_KEY: z.string().optional(),
      AI_BASE_URL: z.url().optional(),
      // Retired with the extraction pipeline; accepted so old .env files still load.
      EXTRACTION_MODEL: z.string().default(""),
      REASONING_MODEL: z.string().default(""),
      TRANSCRIPTION_MODEL: z.string().default(""),
      EMBEDDING_MODEL: z.string().default(""),
      EMBEDDING_DIMENSIONS: z.coerce
        .number()
        .refine((x) => x === 1536, "Database requires 1536 dimensions")
        .default(1536),
      PORT: z.coerce.number().default(3001),
      HOST: z.string().default("127.0.0.1"),
      WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
      MAX_UPLOAD_BYTES: z.coerce.number().max(104857600).default(104857600),
      MAX_RECORDING_SECONDS: z.coerce.number().max(1800).default(1800),
      LOG_LEVEL: z.string().default("info"),
      // The morning brief, pushed through ntfy when NTFY_URL is set.
      NTFY_URL: z.url().optional(),
      NTFY_TOPIC: z.string().default("second-brain"),
      NTFY_TOKEN: z.string().optional(),
      BRIEF_TIME: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .default("07:30"),
    })
    .parse(process.env);
  if (c.NODE_ENV === "production" && !c.APP_ORIGIN.startsWith("https://"))
    throw new Error("Production APP_ORIGIN must use HTTPS");
  if (c.NODE_ENV === "production" && c.AI_PROVIDER === "fake")
    throw new Error("Fake provider is test/development only");
  return c;
}
export type Config = ReturnType<typeof config>;
export type SourceText = {
  id: string;
  content: string;
  createdAt?: string;
  timezone?: string;
  start?: number;
  end?: number;
};
export type RetrievedEvidence = {
  sourceId: string;
  content: string;
  start: number;
  end: number;
  conversationId: string;
  createdAt: string;
  score: number;
  itemId?: string;
  itemRevision?: number;
  itemTitle?: string;
  itemContent?: string;
  epistemicState?: string;
  lifecycle?: string;
  historical?: boolean;
  superseded?: boolean;
};
// Conservative chunk boundaries: at most 2400 code points keeps Unicode token
// counts comfortably within provider limits; full originals are never truncated.
export function chunks(text: string, size = 2400, overlap = 320) {
  const chars = [...text],
    result: { content: string; start: number; end: number }[] = [];
  for (let start = 0; start < chars.length;) {
    const end = Math.min(start + size, chars.length);
    result.push({ content: chars.slice(start, end).join(""), start, end });
    if (end === chars.length) break;
    start = end - overlap;
  }
  return result;
}
export function assertEvidence(evidence: Evidence[], sources: SourceText[]) {
  for (const e of evidence) {
    const s = sources.find((s) => s.id === e.sourceId);
    if (
      !s ||
      e.end <= e.start ||
      e.start < (s.start ?? 0) ||
      e.end > (s.end ?? [...s.content].length) ||
      slice(s.content, e.start - (s.start ?? 0), e.end - (s.start ?? 0)) !==
        e.quote
    )
      fail(
        422,
        "INVALID_EVIDENCE",
        "Source quote does not match its citation.",
      );
  }
}
const fold = (ch: string) =>
  '“”„‟"«»'.includes(ch)
    ? '"'
    : "‘’‚‛'`´".includes(ch)
      ? "'"
      : "‐‑‒–—―".includes(ch)
        ? "-"
        : ch.toLowerCase();
function folded(text: string) {
  const chars = [...text],
    out: string[] = [],
    map: number[] = [];
  for (const [i, ch] of chars.entries()) {
    if (/\s/u.test(ch)) {
      if (out.length && out.at(-1) !== " ") {
        out.push(" ");
        map.push(i);
      }
      continue;
    }
    for (const part of [...fold(ch)]) {
      out.push(part);
      map.push(i);
    }
  }
  while (out.at(-1) === " ") {
    out.pop();
    map.pop();
  }
  return { text: out.join(""), map, chars };
}
/**
 * Finds a quoted phrase in a source and returns code-point offsets with the
 * exact original text. Models copy quotes well but count offsets badly, so the
 * quote is located here; whitespace and typographic quotes may differ.
 */
export function locateQuote(content: string, quote: string) {
  if (!quote.trim()) return null;
  const exact = content.indexOf(quote);
  if (exact >= 0) {
    const start = [...content.slice(0, exact)].length;
    return { start, end: start + [...quote].length, quote };
  }
  const source = folded(content),
    wanted = folded(quote).text;
  if ([...wanted].length < 3) return null;
  const at = source.text.indexOf(wanted);
  if (at < 0) return null;
  const first = [...source.text.slice(0, at)].length,
    last = first + [...wanted].length - 1,
    start = source.map[first]!,
    end = source.map[last]! + 1;
  return { start, end, quote: source.chars.slice(start, end).join("") };
}
