import { AsyncLocalStorage } from "node:async_hooks";

export type ProviderUsage = {
  provider: "openai";
  model: string;
  operation: string;
  schemaVersion: string;
  promptVersion: string | null;
  durationMs: number;
  outcome: "succeeded" | "failed";
  errorCode?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};
const scope = new AsyncLocalStorage<ProviderUsage[]>();
export function withProviderUsage<T>(
  records: ProviderUsage[],
  run: () => Promise<T>,
) {
  return scope.run(records, run);
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
/** An allowlist: never retain requests, response bodies, headers or error messages. */
export async function observeProvider<T>(
  model: string,
  operation: string,
  schemaVersion: string,
  run: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const record: ProviderUsage = {
    provider: "openai",
    model,
    operation,
    schemaVersion,
    promptVersion: operation === "structured" ? `${schemaVersion}:1` : null,
    durationMs: 0,
    outcome: "failed",
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
  try {
    const result = await run();
    const usage = (result as { usage?: Record<string, unknown> }).usage;
    record.inputTokens = count(usage?.prompt_tokens ?? usage?.input_tokens);
    record.outputTokens = count(
      usage?.completion_tokens ?? usage?.output_tokens,
    );
    record.totalTokens = count(usage?.total_tokens);
    record.outcome = "succeeded";
    return result;
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    record.errorCode =
      typeof status === "number" ? `HTTP_${status}` : "REQUEST_FAILED";
    throw error;
  } finally {
    record.durationMs = Math.round(performance.now() - start);
    scope.getStore()?.push(record);
  }
}
