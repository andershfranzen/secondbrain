import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, z } from "@secondbrain/shared";
import {
  provider,
  ProviderError,
  ToolError,
  withProviderUsage,
  exec,
  type ProviderUsage,
} from "@secondbrain/ai";

let server: Server;
let requests: any[];
let replies: {
  status?: number;
  body?: unknown;
  events?: unknown[];
  headers?: Record<string, string>;
}[];
beforeEach(async () => {
  requests = [];
  replies = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] ?? "";
    requests.push({
      url: req.url,
      contentType,
      body: contentType.includes("application/json")
        ? JSON.parse(bytes.toString("utf8"))
        : bytes,
    });
    const reply = replies.shift() ?? {
      status: 500,
      body: { error: { message: "Unexpected request" } },
    };
    if (reply.events) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        reply.events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
          "data: [DONE]\n\n",
      );
      return;
    }
    res.writeHead(reply.status ?? 200, {
      "content-type": "application/json",
      ...reply.headers,
    });
    res.end(JSON.stringify(reply.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  for (const [key, value] of Object.entries({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused/provider_test",
    SESSION_SECRET: "provider-test-secret-with-at-least-32-characters",
    AI_PROVIDER: "openai",
    AI_API_KEY: "synthetic-http-stub-key",
    AI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    REASONING_MODEL: "reason-test",
    EMBEDDING_MODEL: "embed-test",
    TRANSCRIPTION_MODEL: "stt-test",
  }))
    vi.stubEnv(key, value);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  vi.unstubAllEnvs();
});
const completed = (output: unknown[]) => ({
  events: [
    { type: "response.output_text.delta", delta: "untrusted partial" },
    {
      type: "response.completed",
      response: {
        id: "synthetic",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "reason-test",
        output,
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      },
    },
  ],
});
export const toolCall = (name: string, args: unknown, callId = "call-1") =>
  completed([
    {
      type: "function_call",
      id: "fc-1",
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
      status: "completed",
    },
  ]);
export const finalText = (value: unknown) =>
  completed([
    {
      type: "message",
      id: "msg-1",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: JSON.stringify(value), annotations: [] },
      ],
    },
  ]);
const Output = z.strictObject({ answer: z.string() });
function lookupRequest(check?: (v: { answer: string }) => string | null) {
  const seen: string[] = [];
  return {
    seen,
    request: {
      instructions: "Answer using the lookup tool.",
      input: { question: "private-question" },
      tools: [
        {
          name: "lookup",
          description: "Looks a word up.",
          parameters: z.strictObject({
            word: z.string(),
            limit: z.number().nullable(),
          }),
          async run({ word }: { word: string }) {
            seen.push(word);
            if (word === "bad")
              throw new ToolError("No such word; try another.");
            return { results: [`definition of ${word}`] };
          },
        },
      ],
      output: { schema: Output, name: "LookupV1" },
      check,
      signal: new AbortController().signal,
    },
  };
}
describe("OpenAI adapter against a local HTTP stub", () => {
  it("runs a stateless streamed tool loop with strict tools and records allowlisted usage", async () => {
    replies.push(
      toolCall("lookup", { word: "bad", limit: null }),
      toolCall("lookup", { word: "server", limit: 3 }, "call-2"),
      finalText({ answer: "private-answer" }),
    );
    const { request, seen } = lookupRequest(),
      usage: ProviderUsage[] = [];
    const result = await withProviderUsage(usage, () =>
      provider(config()).runAgent(request),
    );
    expect(result.value).toEqual({ answer: "private-answer" });
    expect(seen).toEqual(["bad", "server"]);
    expect(result.steps.map((s) => [s.tool, s.ok])).toEqual([
      ["lookup", false],
      ["lookup", true],
    ]);
    expect(requests).toHaveLength(3);
    for (const r of requests) {
      expect(r.url).toBe("/v1/responses");
      expect(r.body).toMatchObject({
        model: "reason-test",
        store: false,
        stream: true,
        text: {
          format: { type: "json_schema", name: "LookupV1", strict: true },
        },
        tools: [{ type: "function", name: "lookup", strict: true }],
      });
      expect(r.body).not.toHaveProperty("previous_response_id");
    }
    // Each step resends the whole history: no server-side state is assumed.
    const last = requests[2].body.input;
    expect(last.map((i: any) => i.type ?? i.role)).toEqual([
      "user",
      "function_call",
      "function_call_output",
      "function_call",
      "function_call_output",
    ]);
    expect(JSON.parse(last[2].output)).toEqual({
      ok: false,
      error: "No such word; try another.",
    });
    expect(last[4].call_id).toBe("call-2");
    expect(usage).toHaveLength(3);
    expect(usage[2]).toMatchObject({
      model: "reason-test",
      operation: "agent",
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
    });
    expect(JSON.stringify(usage)).not.toMatch(
      /private-|synthetic-http-stub-key/,
    );
  });
  it("returns a rejected final answer to the model with the reason", async () => {
    replies.push(
      finalText({ answer: "incomplete" }),
      finalText({ answer: "complete" }),
    );
    const { request } = lookupRequest((v) =>
      v.answer === "complete" ? null : "Two items are missing.",
    );
    const result = await provider(config()).runAgent(request);
    expect(result.value.answer).toBe("complete");
    const input = requests[1].body.input;
    expect(input.at(-2)).toMatchObject({ role: "assistant" });
    expect(input.at(-1).content).toContain("Two items are missing.");
  });
  it("never accepts a partial stream", async () => {
    replies.push({
      events: [{ type: "response.output_text.delta", delta: '{"answer":"x"}' }],
    });
    await expect(
      provider(config()).runAgent(lookupRequest().request),
    ).rejects.toMatchObject({ code: "PROVIDER_STREAM_INTERRUPTED" });
  });
  it.each([401, 429])(
    "classifies HTTP %i without hidden SDK retries",
    async (status) => {
      replies.push({
        status,
        headers: { "retry-after": "120" },
        body: { error: { message: "private-provider-error" } },
      });
      const usage: ProviderUsage[] = [];
      await expect(
        withProviderUsage(usage, () =>
          provider(config()).runAgent(lookupRequest().request),
        ),
      ).rejects.toMatchObject({
        code: status === 401 ? "PROVIDER_AUTH" : "PROVIDER_429",
        retryable: status === 429,
        retryAfter: 120000,
      });
      expect(requests).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        outcome: "failed",
        errorCode: `HTTP_${status}`,
        totalTokens: null,
      });
      expect(JSON.stringify(usage)).not.toContain("private-provider-error");
    },
  );
  it("transcribes twenty minutes plus a tail without losing chunks or inventing tail timestamps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "secondbrain-long-audio-test-"));
    try {
      const original = join(dir, "original.wav");
      await exec(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=16000:cl=mono",
          "-t",
          "1201",
          "-c:a",
          "pcm_s16le",
          original,
        ],
        { timeout: 15000 },
      );
      replies.push(
        ...[
          "First ten minutes.",
          "Second ten minutes.",
          "Final thought in the tail.",
        ].map((text) => ({ body: { text } })),
      );
      const result = await provider(config()).transcribe(
        original,
        new AbortController().signal,
      );
      expect(result.text).toBe(
        "First ten minutes.\nSecond ten minutes.\nFinal thought in the tail.",
      );
      expect(result.segments).toHaveLength(3);
      expect(requests).toHaveLength(3);
      for (const [i, request] of requests.entries()) {
        expect(request.url).toBe("/v1/audio/transcriptions");
        const form = await new Request("http://stub.invalid", {
          method: "POST",
          headers: { "content-type": request.contentType },
          body: request.body,
        }).formData();
        expect(form.get("model")).toBe("stt-test");
        const file = form.get("file") as File;
        expect(file.size).toBeGreaterThan(0);
        expect(file.size).toBeLessThan(25 * 1024 * 1024);
        const path = join(dir, `received-${i}.mp3`);
        await writeFile(path, Buffer.from(await file.arrayBuffer()));
        const probe = await exec(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            path,
          ],
          { timeout: 5000 },
        );
        const actualMs =
          Number(JSON.parse(probe.stdout).format.duration) * 1000;
        const segment = result.segments[i]!;
        expect(
          Math.abs(segment.endMs - segment.startMs - actualMs),
        ).toBeLessThan(100);
        expect(segment.startMs).toBe(i ? result.segments[i - 1]!.endMs : 0);
      }
      const tail = result.segments[2]!;
      expect(tail.endMs - tail.startMs).toBeGreaterThan(500);
      expect(tail.endMs - tail.startMs).toBeLessThan(1500);
      expect(Math.abs(tail.endMs - 1201000)).toBeLessThan(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("preserves consent failures without sending requests", async () => {
    let checks = 0;
    const ai = provider(config(), async () => {
      checks++;
      throw new ProviderError("CONSENT_REQUIRED", false);
    });
    await expect(ai.runAgent(lookupRequest().request)).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
    });
    expect(checks).toBe(1);
    expect(requests).toEqual([]);
  });
});
