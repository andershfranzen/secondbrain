import OpenAI, { APIError } from "openai";
import { createReadStream, existsSync } from "node:fs";
import {
  chatgptAccessToken,
  ChatGPTAuthError,
  chatgptResource,
} from "./chatgpt-auth.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { observeProvider } from "./usage.js";
import {
  runAgentLoop,
  type AgentRequest,
  type AgentResult,
  type Transport,
} from "./agent.js";
import { fakeAgent } from "./fake-agent.js";
export { withProviderUsage, type ProviderUsage } from "./usage.js";
export * from "./agent.js";
import { hash, type Config } from "@secondbrain/shared";
export const exec = promisify(execFile);
export class ProviderError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
    public retryAfter = 0,
  ) {
    super(code);
  }
}
const failure = (code: string, retryable: boolean) =>
  new ProviderError(code, retryable);
export interface AIProvider {
  configured: boolean;
  capabilities?: { embeddings: boolean; transcription: boolean };
  /** The embedding model; vectors are namespaced by it. */
  model: string;
  runAgent<T>(request: AgentRequest<T>): Promise<AgentResult<T>>;
  embed(
    texts: string[],
    signal: AbortSignal,
    model?: string,
  ): Promise<{ vectors: number[][]; model: string; dimensions: number }>;
  transcribe(
    filePath: string,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    language: string;
    segments: { startMs: number; endMs: number; text: string }[];
  }>;
}
export function provider(
  c: Config,
  authorize: () => Promise<void> = async () => {},
): AIProvider {
  if (c.AI_PROVIDER === "fake") return new FakeProvider();
  const configured =
    (c.AI_PROVIDER === "chatgpt" &&
      existsSync(c.CHATGPT_CREDENTIALS_PATH) &&
      !!c.REASONING_MODEL) ||
    (c.AI_PROVIDER === "openai" &&
      !!c.AI_API_KEY &&
      !!c.REASONING_MODEL &&
      !!c.EMBEDDING_MODEL &&
      !!c.TRANSCRIPTION_MODEL);
  const client = new OpenAI({
    apiKey: c.AI_API_KEY || "not-configured",
    baseURL: c.AI_BASE_URL,
    maxRetries: 0,
    timeout: 180000,
  });
  /**
   * One streamed Responses call. Only a completed response is ever accepted.
   * Without storage the subscription route sends output only as streamed
   * items and completes with an empty output list, so the items are kept.
   */
  async function stream(
    api: OpenAI,
    body: Parameters<Transport>[0],
    signal: AbortSignal,
  ) {
    const events = await api.responses.create(
      { ...body, store: false, stream: true },
      { signal },
    );
    const items: OpenAI.Responses.ResponseOutputItem[] = [];
    for await (const event of events) {
      if (event.type === "response.output_item.done")
        items[event.output_index] = event.item;
      if (event.type === "response.completed")
        return event.response.output.length
          ? event.response
          : { ...event.response, output: items.filter(Boolean) };
      if (event.type === "response.failed") {
        const code = event.response.error?.code as string | undefined;
        throw code?.startsWith("subscription_sharing_usage_")
          ? new ProviderError("CHATGPT_ALLOWANCE_UNAVAILABLE", true, 3600000)
          : new ProviderError("PROVIDER_FAILED", true);
      }
      if (event.type === "response.incomplete" || event.type === "error")
        throw new ProviderError("PROVIDER_INCOMPLETE", true);
    }
    throw new ProviderError("PROVIDER_STREAM_INTERRUPTED", true);
  }
  /**
   * The subscription route: a renewable ChatGPT OAuth token against the public
   * Responses endpoint. It never falls back to Platform billing.
   */
  async function subscription(
    body: Parameters<Transport>[0],
    signal: AbortSignal,
  ) {
    try {
      let token = await chatgptAccessToken(c.CHATGPT_CREDENTIALS_PATH, signal);
      for (let attempt = 0; attempt < 2; attempt++) {
        const subscribed = new OpenAI({
          apiKey: token,
          baseURL: chatgptResource,
          maxRetries: 0,
          timeout: 180000,
        });
        try {
          return await stream(subscribed, body, signal);
        } catch (error) {
          if (
            error instanceof APIError &&
            error.status === 401 &&
            attempt === 0
          ) {
            token = await chatgptAccessToken(
              c.CHATGPT_CREDENTIALS_PATH,
              signal,
              token,
            );
            continue;
          }
          if (
            error instanceof APIError &&
            error.code?.startsWith("subscription_sharing_usage_")
          )
            throw new ProviderError(
              "CHATGPT_ALLOWANCE_UNAVAILABLE",
              true,
              3600000,
            );
          throw error;
        }
      }
      throw new ProviderError("CHATGPT_REAUTH_REQUIRED", false);
    } catch (error) {
      if (error instanceof ChatGPTAuthError)
        throw new ProviderError(
          error.code,
          ["CHATGPT_REFRESH_BUSY", "CHATGPT_REFRESH_UNAVAILABLE"].includes(
            error.code,
          ),
        );
      throw error;
    }
  }
  const transport: Transport = async (body, signal) => {
    await authorize();
    try {
      return await observeProvider(body.model, "agent", "AgentTurnV1", () =>
        c.AI_PROVIDER === "chatgpt"
          ? subscription(body, signal)
          : stream(client, body, signal),
      );
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e instanceof OpenAI.APIError) throw classify(e);
      if (signal.aborted) throw new ProviderError("PROVIDER_TIMEOUT", true);
      throw new ProviderError("PROVIDER_FAILED", true);
    }
  };
  return {
    configured,
    capabilities: {
      embeddings: c.AI_PROVIDER !== "chatgpt",
      transcription: c.AI_PROVIDER !== "chatgpt",
    },
    model: c.EMBEDDING_MODEL,
    runAgent: (request) =>
      runAgentLoop(transport, c.REASONING_MODEL, request, failure),
    async embed(texts, signal, model = c.EMBEDDING_MODEL) {
      if (c.AI_PROVIDER === "chatgpt")
        throw new ProviderError("EMBEDDINGS_NOT_CONFIGURED", false);
      try {
        await authorize();
        const r = await observeProvider(
          model,
          "embed",
          "Embeddings1536V1",
          () =>
            client.embeddings.create(
              {
                model,
                input: texts,
                dimensions: 1536,
                encoding_format: "float",
              },
              { signal },
            ),
        );
        const vectors = r.data
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding);
        if (
          vectors.length !== texts.length ||
          vectors.some(
            (v) => v.length !== 1536 || v.some((n) => !Number.isFinite(n)),
          )
        )
          throw new ProviderError("INVALID_EMBEDDING", false);
        return { vectors, model, dimensions: 1536 };
      } catch (e) {
        if (e instanceof OpenAI.APIError) throw classify(e);
        throw e;
      }
    },
    async transcribe(filePath, signal) {
      if (c.AI_PROVIDER === "chatgpt")
        throw new ProviderError("TRANSCRIPTION_NOT_CONFIGURED", false);
      const dir = await mkdtemp(join(tmpdir(), "secondbrain-stt-"));
      try {
        await exec(
          "ffmpeg",
          [
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            filePath,
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "48k",
            "-f",
            "segment",
            "-segment_time",
            "600",
            "-segment_list",
            join(dir, "segments.csv"),
            "-segment_list_type",
            "csv",
            "-reset_timestamps",
            "1",
            join(dir, "part-%03d.mp3"),
          ],
          { timeout: 120000, maxBuffer: 1048576, signal },
        );
        // Use the muxer's actual boundaries. MP3 frames need not land on exactly
        // ten minutes, and a short final chunk must not claim another ten minutes.
        const manifest = (await readFile(join(dir, "segments.csv"), "utf8"))
          .trim()
          .split("\n");
        const files = manifest.map((line) => {
          const match =
            /^(part-[0-9]{3}\.mp3),([0-9]+(?:\.[0-9]+)?),([0-9]+(?:\.[0-9]+)?)$/.exec(
              line.trim(),
            );
          if (!match || Number(match[3]) <= Number(match[2]))
            throw new ProviderError("INVALID_AUDIO_SEGMENTS", false);
          return {
            name: match[1]!,
            startMs: Math.round(Number(match[2]) * 1000),
            endMs: Math.round(Number(match[3]) * 1000),
          };
        });
        const segments = [];
        for (const { name, startMs, endMs } of files) {
          await authorize();
          const r = await observeProvider(
            c.TRANSCRIPTION_MODEL,
            "transcribe",
            "TranscriptionV1",
            () =>
              client.audio.transcriptions.create(
                {
                  model: c.TRANSCRIPTION_MODEL,
                  file: createReadStream(join(dir, name)),
                  response_format: "json",
                },
                {
                  signal: AbortSignal.any([
                    signal,
                    AbortSignal.timeout(300000),
                  ]),
                },
              ),
          );
          segments.push({
            startMs,
            endMs,
            text: r.text,
          });
        }
        return {
          text: segments.map((s) => s.text).join("\n"),
          language: "und",
          segments,
        };
      } catch (e) {
        if (e instanceof OpenAI.APIError) throw classify(e);
        throw e;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
function classify(e: APIError) {
  const status = e.status ?? 500;
  return new ProviderError(
    status === 401 || status === 403
      ? "PROVIDER_AUTH"
      : status === 400 || status === 404
        ? "PROVIDER_CONFIG"
        : `PROVIDER_${status}`,
    status === 429 || status >= 500,
    Number(e.headers?.get("retry-after") ?? 0) * 1000,
  );
}
// Explicitly selected test/development adapter. It does not pretend to be an LLM:
// a scripted agent drives the real tools so validation and commits are exercised.
export class FakeProvider implements AIProvider {
  configured = true;
  model = "fake-1536-v1";
  async runAgent<T>(request: AgentRequest<T>): Promise<AgentResult<T>> {
    return fakeAgent(request, failure);
  }
  async embed(texts: string[]) {
    return {
      model: this.model,
      dimensions: 1536,
      vectors: texts.map((t) => {
        const v = Array<number>(1536).fill(0);
        for (const word of t.toLowerCase().split(/\W+/)) {
          const n = parseInt(hash(word).slice(0, 6), 16) % 1536;
          v[n] += 1;
        }
        if (!v.some(Boolean)) v[0] = 1;
        return v;
      }),
    };
  }
  async transcribe(filePath: string) {
    await readFile(filePath);
    return {
      text: "A synthetic voice capture for testing.",
      language: "en",
      segments: [
        {
          startMs: 0,
          endMs: 1000,
          text: "A synthetic voice capture for testing.",
        },
      ],
    };
  }
}
