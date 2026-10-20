import type OpenAI from "openai";
import { zodResponsesFunction, zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

/** A tool's own validation failure: returned to the model so it can correct itself. */
export class ToolError extends Error {}
export type AgentTool = {
  name: string;
  description: string;
  parameters: z.ZodObject<any>;
  run(args: any): Promise<unknown>;
};
export type AgentStep = {
  tool: string;
  arguments: unknown;
  ok: boolean;
  summary: string;
};
/** What a running agent is doing: a tool it calls, its answer so far, or a retry after a rejected answer. */
export type AgentProgress =
  | { type: "tool"; tool: string }
  | { type: "text"; text: string }
  | { type: "revise" };
export type AgentRequest<T> = {
  instructions: string;
  input: unknown;
  tools: AgentTool[];
  output: { schema: z.ZodType<T>; name: string };
  /** Returns a reason the final answer is unacceptable, or null to accept it. */
  check?: (value: T) => Promise<string | null> | string | null;
  maxSteps?: number;
  signal: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
};
export type AgentResult<T> = { value: T; steps: AgentStep[]; model: string };
type ResponseBody = {
  model: string;
  instructions: string;
  input: OpenAI.Responses.ResponseInput;
  tools?: OpenAI.Responses.Tool[];
  text: OpenAI.Responses.ResponseTextConfig;
  parallel_tool_calls?: boolean;
};
export type Transport = (
  body: ResponseBody,
  signal: AbortSignal,
  /** Receives output text as it streams. */
  onText?: (delta: string) => void,
) => Promise<OpenAI.Responses.Response>;
export type ProviderFailure = (code: string, retryable: boolean) => Error;

export function summarize(result: unknown): string {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.ok === false) return `error: ${String(r.error).slice(0, 300)}`;
    if (Array.isArray(r.items))
      return `${r.items.length} of ${r.total ?? r.items.length} items`;
    if (Array.isArray(r.results)) return `${r.results.length} results`;
    if (typeof r.id === "string") return `item ${r.id}`;
    if (typeof r.sourceId === "string") return `source ${r.sourceId}`;
  }
  return "ok";
}
export function outputText(response: OpenAI.Responses.Response) {
  return response.output
    .flatMap((item) =>
      item.type === "message"
        ? item.content
            .filter((part) => part.type === "output_text")
            .map((part) => part.text)
        : [],
    )
    .join("");
}
/** Runs one tool call; schema and tool errors become results the model can see. */
export async function callTool(tool: AgentTool | undefined, raw: string) {
  if (!tool) return { ok: false, error: "Unknown tool." };
  let args: unknown;
  try {
    args = tool.parameters.parse(JSON.parse(raw));
  } catch {
    return {
      ok: false,
      error:
        "Arguments did not match this tool's schema. Check field names and types.",
    };
  }
  try {
    return await tool.run(args);
  } catch (error) {
    if (error instanceof ToolError) return { ok: false, error: error.message };
    throw error;
  }
}
/**
 * A bounded tool loop over the Responses API. The subscription route keeps no
 * server-side state (store:false, no previous_response_id), so each step resends
 * the history: the original input, every function call and every tool result.
 */
export async function runAgentLoop<T>(
  transport: Transport,
  model: string,
  request: AgentRequest<T>,
  failure: ProviderFailure,
): Promise<AgentResult<T>> {
  const byName = new Map(request.tools.map((t) => [t.name, t]));
  const tools = request.tools.map((t) => {
    const f = zodResponsesFunction({
      name: t.name,
      parameters: t.parameters,
      description: t.description,
    });
    return {
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: f.parameters,
      strict: true,
    };
  });
  const text = {
    format: zodTextFormat(request.output.schema as any, request.output.name),
  };
  const input: OpenAI.Responses.ResponseInputItem[] = [
    { role: "user", content: JSON.stringify(request.input) },
  ];
  const steps: AgentStep[] = [];
  let rejections = 0;
  for (let step = 0; step < (request.maxSteps ?? 30); step++) {
    if (request.signal.aborted) throw failure("PROVIDER_TIMEOUT", true);
    let streamed = "";
    const progress = request.onProgress;
    const response = await transport(
      {
        model,
        instructions: request.instructions,
        input,
        text,
        ...(tools.length ? { tools, parallel_tool_calls: true } : {}),
      },
      request.signal,
      progress &&
        ((delta) => {
          streamed += delta;
          progress({ type: "text", text: streamed });
        }),
    );
    const calls = response.output.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
        item.type === "function_call",
    );
    if (calls.length) {
      for (const call of calls) {
        request.onProgress?.({ type: "tool", tool: call.name });
        input.push({
          type: "function_call",
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments,
        });
        const result = await callTool(byName.get(call.name), call.arguments);
        let args: unknown = null;
        try {
          args = JSON.parse(call.arguments);
        } catch {}
        steps.push({
          tool: call.name,
          arguments: args,
          ok: (result as { ok?: boolean })?.ok !== false,
          summary: summarize(result),
        });
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }
      continue;
    }
    const raw = outputText(response);
    let value: T | undefined,
      problem: string | null = null;
    try {
      value = request.output.schema.parse(JSON.parse(raw));
    } catch {
      problem = "It was not valid JSON for the required output schema.";
    }
    if (!problem && request.check) problem = await request.check(value!);
    if (!problem) return { value: value!, steps, model };
    if (++rejections > 3) throw failure("AGENT_OUTPUT_REJECTED", true);
    request.onProgress?.({ type: "revise" });
    input.push({ role: "assistant", content: raw || "(no output)" });
    input.push({
      role: "user",
      content: `Your final answer was rejected: ${problem} Fix it, using tools if needed, then give the complete final answer again.`,
    });
  }
  throw failure("AGENT_STEP_LIMIT", true);
}
