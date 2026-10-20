import type { AgentOutput, ConverseInput } from "@secondbrain/shared";
import {
  callTool,
  summarize,
  type AgentRequest,
  type AgentResult,
  type AgentStep,
  type ProviderFailure,
} from "./agent.js";

/**
 * Deterministic stand-in for the model in tests and local development. It is
 * not product logic: it drives the same tools a real model would, through the
 * same schema checks, so validation, commits and completeness are exercised.
 */
export async function fakeAgent<T>(
  request: AgentRequest<T>,
  failure: ProviderFailure,
): Promise<AgentResult<T>> {
  const steps: AgentStep[] = [];
  const tool = async (name: string, args: Record<string, unknown>) => {
    request.onProgress?.({ type: "tool", tool: name });
    const result: any = await callTool(
      request.tools.find((t) => t.name === name),
      JSON.stringify(args),
    );
    steps.push({
      tool: name,
      arguments: args,
      ok: result?.ok !== false,
      summary: summarize(result),
    });
    return result;
  };
  const input = request.input as ConverseInput;
  const value = (await converse(input, tool)) as T;
  request.onProgress?.({ type: "text", text: JSON.stringify(value) });
  const problem = request.check ? await request.check(value) : null;
  if (problem) throw failure("AGENT_OUTPUT_REJECTED", true);
  return { value, steps, model: "fake-agent" };
}
type Tool = (name: string, args: Record<string, unknown>) => Promise<any>;
const listArgs = {
  kinds: null,
  status: null,
  person: null,
  project: null,
  text: null,
  includeArchived: null,
  forAnswer: false,
};
const createArgs = {
  category: null,
  entityType: null,
  requestedBy: null,
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
};
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.filter(
        (w) => !["that", "this", "with", "have", "from", "will"].includes(w),
      ) ?? [],
  );
async function converse(
  input: ConverseInput,
  tool: Tool,
): Promise<AgentOutput> {
  const text = input.message.sources
    .map((s) => s.text)
    .join("\n")
    .trim();
  const asks =
    !input.hint &&
    (/[?？]\s*$/.test(text) ||
      /^(find|search|what|where|when|who|how|which|list|show|did|do|does|is|are)\b/i.test(
        text,
      ));
  if (asks) return answer(text, tool);
  const actions: string[] = [];
  for (const source of input.message.sources)
    for (const raw of source.text.split(/(?<=[.!?])\s+|\n+/)) {
      const sentence = raw.trim();
      if (sentence.length < 3) continue;
      const evidence = [{ sourceId: source.sourceId, quote: sentence }];
      const hedged = /\?|maybe|I think|not sure|probably|måske/i.test(sentence);
      if (
        /\b(finished|done with|completed|shipped|delivered|handed over)\b/i.test(
          sentence,
        )
      ) {
        const open = await tool("list_items", {
          ...listArgs,
          kinds: ["task"],
          status: "open",
        });
        const mine = words(sentence);
        const match = (open.items ?? []).find(
          (item: any) =>
            [...words(item.title + " " + item.content)].filter((w) =>
              mine.has(w),
            ).length >= 2,
        );
        if (match) {
          const done = await tool("update_item", {
            id: match.id,
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
            evidence,
            reason: "The note says this is done.",
          });
          if (done.ok !== false) actions.push(`Completed: ${match.title}`);
          continue;
        }
      }
      if (
        /\b(asked me to|I said yes|I agreed|I promised|I will|I'll|I need to|jeg vil|jeg skal)\b/i.test(
          sentence,
        )
      ) {
        const requestedBy =
          /\b([A-ZÆØÅ][\p{L}]+) asked me\b/u.exec(tidy(sentence))?.[1] ?? null;
        const dueHint =
          /\b(next (?:week|month|year)|tomorrow|after [^,.]+|in \w+ (?:days|weeks|months))\b/i.exec(
            sentence,
          )?.[1] ?? null;
        const title = label(action(tidy(sentence)) ?? tidy(sentence));
        const created = await tool("create_item", {
          ...createArgs,
          kind: "task",
          title,
          content: tidy(sentence),
          certainty: hedged ? "unconfirmed" : "confirmed",
          evidence,
          requestedBy,
          dueHint,
          status: "open",
          reason: "The note records a commitment.",
        });
        if (created.ok !== false) actions.push(`New commitment: ${title}`);
        continue;
      }
      const idea = /\b(idea|maybe|måske)\b/i.test(sentence);
      const title = label(tidy(sentence));
      const created = await tool("create_item", {
        ...createArgs,
        kind: idea ? "idea" : "memory",
        title,
        content: tidy(sentence),
        certainty: hedged ? "unconfirmed" : "confirmed",
        evidence,
        category: idea ? null : "context",
        reason: "The note records this.",
      });
      if (created.ok !== false) actions.push(`Noted: ${title}`);
    }
  return {
    messageKind: "note",
    reply: actions.length ? `Saved. ${actions.join(" · ")}` : "Saved.",
    claims: [],
    accounted: [],
    insufficientEvidence: false,
    openListScope: null,
  };
}
/** Drops filler and lead-ins, as the real agent is told to; meaning is kept. */
function tidy(sentence: string) {
  const text = sentence
    .replace(
      /^(?:(?:ok(?:ay)?|so|well|anyway|note to self|standup notes)\b[:,]?\s*)+/i,
      "",
    )
    .replace(/\b(?:uh+|um+|lol|basically|kinda|you know|like,)\s*/gi, "")
    .replace(/\s*,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
  const clean = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}
/** The thing agreed to: "X asked me to build the dashboard" → "build the dashboard". */
function action(sentence: string) {
  return /\b(?:asked me to|I promised to|I agreed to|I need to|I'll|I will)\s+(.+?)(?=,|;|\.|\band I\b|\bbut\b|\bnext\b|\bafter\b|\btomorrow\b|$)/i.exec(
    sentence,
  )?.[1];
}
function label(text: string) {
  const words = text
    .replace(/[.!?]+$/, "")
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join(" ");
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 120);
}
async function answer(text: string, tool: Tool): Promise<AgentOutput> {
  if (
    /outstanding|open|todo|to-do|commitment|promised|owe|still have|pending|projects/i.test(
      text,
    )
  ) {
    const listed = await tool("list_items", {
      ...listArgs,
      kinds: ["task", "project"],
      status: "open",
      forAnswer: true,
    });
    const claims = [];
    for (const item of listed.items ?? []) {
      const full = await tool("get_item", { id: item.id });
      const quote = full.evidence?.[0];
      if (!quote) continue;
      claims.push({
        text: `${item.title}${item.requestedBy ? ` (for ${item.requestedBy})` : ""}${item.certainty === "unconfirmed" ? " — unconfirmed" : ""}`,
        citations: [{ sourceId: quote.sourceId, quote: quote.quote }],
        itemIds: [item.id],
      });
    }
    const cited = new Set(claims.flatMap((c) => c.itemIds));
    return {
      messageKind: "question",
      reply: claims.length
        ? `You have ${claims.length} open ${claims.length === 1 ? "item" : "items"}.`
        : "You have nothing outstanding.",
      claims,
      accounted: (listed.items ?? []).map((item: any) => ({
        itemId: item.id,
        included: cited.has(item.id),
        reason: cited.has(item.id) ? "" : "No source quote available.",
      })),
      insufficientEvidence: !claims.length,
      openListScope: null,
    };
  }
  const query =
    text
      .replace(/^(find|search(?: for)?|show me|look up)\s+/i, "")
      .replace(/[?？]\s*$/, "") || text;
  const found = await tool("search_notes", { query, limit: 4 });
  const claims = (found.results ?? []).slice(0, 4).map((r: any) => ({
    text: r.excerpt,
    citations: [{ sourceId: r.sourceId, quote: r.excerpt }],
    itemIds: r.itemId ? [r.itemId] : [],
  }));
  return {
    messageKind: "question",
    reply: claims.length
      ? "Here is what you saved:"
      : "I couldn't find anything you saved about that.",
    claims,
    accounted: [],
    insufficientEvidence: !claims.length,
    openListScope: null,
  };
}
