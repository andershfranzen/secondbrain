import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provider } from "@secondbrain/ai";
import { config, z } from "@secondbrain/shared";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  chatgptAccessToken,
  readChatGPTCredentials,
  writeProtectedJSON,
  tokenExpiry,
  verifyChatGPTIdentity,
  readChatGPTRegistration,
} from "../packages/ai/src/chatgpt-auth.js";

import { connectChatGPT } from "../packages/ai/src/chatgpt-connect.js";
const nativeFetch = globalThis.fetch;
const { publicKey, privateKey } = await generateKeyPair("RS256");
const key = {
  ...(await exportJWK(publicKey)),
  kid: "synthetic-key",
  alg: "RS256",
  use: "sig",
};
let dir: string, path: string;
const record = () => ({
  issuer: "https://auth.openai.com",
  subject: "synthetic-subject",
  client_id: "oaiapp_synthetic",
  ext_agent_host_id: "urn:uuid:synthetic",
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  id_token: "synthetic-id-token",
  scopes: ["chatgpt.tokens.use.direct"],
  expires_at: Date.now() + 3600000,
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secondbrain-chatgpt-"));
  path = join(dir, "connection.json");
  await writeProtectedJSON(path, record());
  for (const [key, value] of Object.entries({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused/chatgpt_test",
    SESSION_SECRET: "chatgpt-test-secret-at-least-32-characters",
    AI_PROVIDER: "chatgpt",
    AI_API_KEY: "must-never-be-used",
    AI_BASE_URL: "https://must-never-be-used.invalid/v1",
    CHATGPT_CREDENTIALS_PATH: path,
    EXTRACTION_MODEL: "account-model",
    REASONING_MODEL: "account-model",
  }))
    vi.stubEnv(key, value);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const PlanOutput = z.strictObject({
  query: z.string(),
  historical: z.boolean(),
});
const ask = async (ai = provider(config())) =>
  (
    await ai.runAgent({
      instructions: "Plan the search.",
      input: { question: "Find server" },
      tools: [],
      output: { schema: PlanOutput, name: "RecallPlanV1" },
      signal: signal(),
    })
  ).value;
function eventResponse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
const completed = () => ({
  type: "response.completed",
  response: {
    id: "synthetic",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "account-model",
    output: [
      {
        type: "message",
        id: "synthetic-message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({ query: "Home Server", historical: false }),
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
  },
});
describe("ChatGPT subscription connection", () => {
  it("validates the signed identity, issued-client audience and original nonce", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        expect(String(input)).toBe(
          "https://auth.openai.com/.well-known/jwks.json",
        );
        return Response.json({ keys: [key] });
      }),
    );
    const token = await new SignJWT({
      nonce: "original-nonce",
      email: "synthetic@example.invalid",
    })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
      .setIssuer("https://auth.openai.com")
      .setSubject("synthetic-subject")
      .setAudience("oaiapp_synthetic")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(
      await verifyChatGPTIdentity(token, "oaiapp_synthetic", "original-nonce"),
    ).toEqual({
      subject: "synthetic-subject",
      email: "synthetic@example.invalid",
    });
    await expect(
      verifyChatGPTIdentity(token, "oaiapp_synthetic", "other-nonce"),
    ).rejects.toThrow("CHATGPT_NONCE_MISMATCH");
    await expect(
      verifyChatGPTIdentity(token, "oaiapp_other", "original-nonce"),
    ).rejects.toThrow();
    const jwt = `${btoa("{}")}.${btoa(JSON.stringify({ exp: 100 }))}.unsigned`;
    expect(tokenExpiry(jwt, 3600, 0)).toBe(100000);
  });
  it("completes loopback registration with state, PKCE, signed nonce and retained identity", async () => {
    await rm(path);
    let auth!: URL;
    const fetcher = vi.fn(async (input: any, init: any) => {
      if (String(input).endsWith("/jwks.json"))
        return Response.json({ keys: [key] });
      expect(String(input)).toBe(
        "https://auth.openai.com/api/accounts/oauth/token",
      );
      const body = init.body as URLSearchParams;
      expect(body.get("redirect_uri")).toBe(
        auth.searchParams.get("redirect_uri"),
      );
      expect(body.get("client_id")).toBe("oaiapp_registered");
      expect(body.get("resource")).toBe("https://api.openai.com/v1");
      const { createHash } = await import("node:crypto");
      expect(
        createHash("sha256")
          .update(body.get("code_verifier")!)
          .digest("base64url"),
      ).toBe(auth.searchParams.get("code_challenge"));
      const id = await new SignJWT({ nonce: auth.searchParams.get("nonce") })
        .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
        .setIssuer("https://auth.openai.com")
        .setSubject("synthetic-subject")
        .setAudience("oaiapp_registered")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        id_token: id,
        scope: "openid chatgpt.tokens.use.direct",
        expires_in: 3600,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const connection = connectChatGPT(
      path,
      AbortSignal.timeout(10000),
      (url) => {
        auth = url;
        ready();
      },
    );
    await started;
    expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(auth.searchParams.get("agent_name_hint")).toBe("Second Brain");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    expect(callback.hostname).toBe("127.0.0.1");
    callback.searchParams.set("code", "synthetic-code");
    callback.searchParams.set("client_id", "oaiapp_registered");
    callback.searchParams.set("state", "wrong-state");
    expect((await nativeFetch(callback)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    expect((await nativeFetch(callback)).status).toBe(200);
    await connection;
    expect(await readChatGPTCredentials(path)).toMatchObject({
      client_id: "oaiapp_registered",
      subject: "synthetic-subject",
      access_token: "new-access",
    });
    expect(await readChatGPTRegistration(path)).toEqual({
      issuer: "https://auth.openai.com",
      client_id: "oaiapp_registered",
      subject: "synthetic-subject",
      ext_agent_host_id: auth.searchParams.get("ext_agent_host_id"),
    });
    // Revocation removes tokens, but reauthorization reuses the existing mapping.
    await rm(path);
    const controller = new AbortController();
    let readyAgain!: () => void;
    const again = new Promise<void>((resolve) => {
      readyAgain = resolve;
    });
    const reauth = connectChatGPT(path, controller.signal, (url) => {
      auth = url;
      readyAgain();
    });
    const stopped = expect(reauth).rejects.toThrow("CHATGPT_SIGN_IN_TIMEOUT");
    await again;
    expect(auth.searchParams.get("client_id")).toBe("oaiapp_registered");
    expect(auth.searchParams.has("agent_name_hint")).toBe(false);
    controller.abort();
    await stopped;
    await expect(
      nativeFetch(auth.searchParams.get("redirect_uri")!),
    ).rejects.toThrow();
  });
  it("protects credential files and rejects permissive files", async () => {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await chatgptAccessToken(path, signal())).toBe("synthetic-access");
    await chmod(path, 0o644);
    await expect(readChatGPTCredentials(path)).rejects.toThrow(
      "CHATGPT_CREDENTIAL_PERMISSIONS",
    );
  });
  it("serializes concurrent rotating refreshes and atomically retains the replacement", async () => {
    await writeProtectedJSON(path, { ...record(), expires_at: 0 });
    const fetcher = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe(
        "https://auth.openai.com/api/accounts/oauth/token",
      );
      expect(init.body.get("client_id")).toBe("oaiapp_synthetic");
      expect(init.body.get("resource")).toBe("https://api.openai.com/v1");
      expect(init.body.has("scope")).toBe(false);
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const results = await Promise.all(
      [1, 2, 3].map(() => chatgptAccessToken(path, signal())),
    );
    expect(results).toEqual([
      "rotated-access",
      "rotated-access",
      "rotated-access",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readChatGPTCredentials(path)).toMatchObject({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      subject: "synthetic-subject",
    });
  });
  it("quarantines revoked refresh grants rather than repeatedly replaying them", async () => {
    await writeProtectedJSON(path, { ...record(), expires_at: 0 });
    const fetcher = vi.fn(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(chatgptAccessToken(path, signal())).rejects.toThrow(
      "CHATGPT_REAUTH_REQUIRED",
    );
    await expect(chatgptAccessToken(path, signal())).rejects.toThrow(
      "CHATGPT_REAUTH_REQUIRED",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not replay a possibly rotated token after a malformed successful refresh", async () => {
    await writeProtectedJSON(path, { ...record(), expires_at: 0 });
    const fetcher = vi.fn(async () =>
      Response.json({ access_token: "new-but-incomplete" }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(chatgptAccessToken(path, signal())).rejects.toThrow(
      "CHATGPT_REAUTH_REQUIRED",
    );
    await expect(chatgptAccessToken(path, signal())).rejects.toThrow(
      "CHATGPT_REAUTH_REQUIRED",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retries network refresh failures without pretending the model output was invalid", async () => {
    await writeProtectedJSON(path, { ...record(), expires_at: 0 });
    const fetcher = vi.fn(async () => {
      throw new TypeError("synthetic network failure");
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(ask()).rejects.toMatchObject({
      code: "CHATGPT_REFRESH_UNAVAILABLE",
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refreshes once on 401 and uses only the replacement OAuth token", async () => {
    let inference = 0;
    const fetcher = vi.fn(async (input: any, init: any) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/oauth/token"))
        return Response.json({
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          expires_in: 3600,
        });
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      if (++inference === 1)
        return Response.json(
          {
            error: {
              message: "synthetic expired",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          },
          { status: 401 },
        );
      expect(request.headers.get("authorization")).toBe(
        "Bearer replacement-access",
      );
      return eventResponse([completed()]);
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await ask()).toEqual({ query: "Home Server", historical: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("classifies allowance errors before the stream opens without paid fallback", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "synthetic limit",
            type: "usage_limit",
            code: "subscription_sharing_usage_limit_exceeded",
          },
        },
        { status: 429 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(ask()).rejects.toMatchObject({
      code: "CHATGPT_ALLOWANCE_UNAVAILABLE",
      retryable: true,
      retryAfter: 3600000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires plan-use scope even if an identity and valid token exist", async () => {
    await writeProtectedJSON(path, { ...record(), scopes: ["openid"] });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(chatgptAccessToken(path, signal())).rejects.toThrow(
      "CHATGPT_PLAN_PERMISSION_REQUIRED",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses only subscription Responses with strict output and completed streaming", async () => {
    const fetcher = vi.fn(async (input: any, init: any) => {
      const request = new Request(input, init),
        body = await request.json();
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(request.headers.get("authorization")).toBe(
        "Bearer synthetic-access",
      );
      expect(body).toMatchObject({
        model: "account-model",
        store: false,
        stream: true,
        text: {
          format: { type: "json_schema", name: "RecallPlanV1", strict: true },
        },
      });
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("previous_response_id");
      return eventResponse([
        { type: "response.output_text.delta", delta: "untrusted partial" },
        completed(),
      ]);
    });
    vi.stubGlobal("fetch", fetcher);
    const ai = provider(config());
    expect(ai.configured).toBe(true);
    expect(ai.capabilities).toEqual({
      embeddings: false,
      transcription: false,
    });
    expect(await ask(ai)).toEqual({ query: "Home Server", historical: false });
    await expect(ai.embed(["text"], signal())).rejects.toThrow(
      "EMBEDDINGS_NOT_CONFIGURED",
    );
    await expect(ai.transcribe("unused-file", signal())).rejects.toThrow(
      "TRANSCRIPTION_NOT_CONFIGURED",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("runs the agent's tool loop on the subscription, resending history each step", async () => {
    const bodies: any[] = [];
    const fetcher = vi.fn(async (input: any, init: any) => {
      const request = new Request(input, init),
        body = await request.json();
      bodies.push(body);
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(request.headers.get("authorization")).toBe(
        "Bearer synthetic-access",
      );
      expect(body).toMatchObject({
        model: "account-model",
        store: false,
        stream: true,
      });
      expect(body).not.toHaveProperty("previous_response_id");
      if (bodies.length === 1)
        return eventResponse([
          {
            type: "response.completed",
            response: {
              ...completed().response,
              output: [
                {
                  type: "function_call",
                  id: "fc-1",
                  call_id: "call-1",
                  name: "list_items",
                  arguments: JSON.stringify({ status: "open" }),
                  status: "completed",
                },
              ],
            },
          },
        ]);
      return eventResponse([completed()]);
    });
    vi.stubGlobal("fetch", fetcher);
    const calls: unknown[] = [];
    const result = await provider(config()).runAgent({
      instructions: "List, then plan.",
      input: { question: "What is outstanding?" },
      tools: [
        {
          name: "list_items",
          description: "Lists open items.",
          parameters: z.strictObject({ status: z.enum(["open", "any"]) }),
          async run(args) {
            calls.push(args);
            return { total: 1, items: [{ id: "item-1", title: "Dashboard" }] };
          },
        },
      ],
      output: { schema: PlanOutput, name: "RecallPlanV1" },
      signal: signal(),
    });
    expect(result.value).toEqual({ query: "Home Server", historical: false });
    expect(calls).toEqual([{ status: "open" }]);
    expect(bodies[0].tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "list_items",
        strict: true,
      }),
    ]);
    expect(bodies[1].input.slice(1)).toEqual([
      {
        type: "function_call",
        call_id: "call-1",
        name: "list_items",
        arguments: '{"status":"open"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: JSON.stringify({
          total: 1,
          items: [{ id: "item-1", title: "Dashboard" }],
        }),
      },
    ]);
  });
  it("reads output the subscription streams only as items, completing with an empty list", async () => {
    const streamed = (item: object) =>
      eventResponse([
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: { ...completed().response, output: [] },
        },
      ]);
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++requests === 1
          ? streamed({
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              name: "list_items",
              arguments: JSON.stringify({ status: "open" }),
              status: "completed",
            })
          : streamed(completed().response.output[0]!),
      ),
    );
    const calls: unknown[] = [];
    const result = await provider(config()).runAgent({
      instructions: "List, then plan.",
      input: { question: "What is outstanding?" },
      tools: [
        {
          name: "list_items",
          description: "Lists open items.",
          parameters: z.strictObject({ status: z.enum(["open", "any"]) }),
          async run(args) {
            calls.push(args);
            return { total: 0, items: [] };
          },
        },
      ],
      output: { schema: PlanOutput, name: "RecallPlanV1" },
      signal: signal(),
    });
    expect(calls).toEqual([{ status: "open" }]);
    expect(result.value).toEqual({ query: "Home Server", historical: false });
  });
  it("never accepts a partial stream or falls back to Platform billing", async () => {
    const fetcher = vi.fn(async () =>
      eventResponse([
        {
          type: "response.output_text.delta",
          delta: '{"query":"partial","historical":false}',
        },
      ]),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(ask()).rejects.toThrow("PROVIDER_STREAM_INTERRUPTED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves allowance errors even after streaming starts", async () => {
    const fetcher = vi.fn(async () =>
      eventResponse([
        {
          type: "response.failed",
          response: {
            error: { code: "subscription_sharing_usage_limit_exceeded" },
          },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(ask()).rejects.toMatchObject({
      code: "CHATGPT_ALLOWANCE_UNAVAILABLE",
      retryable: true,
      retryAfter: 3600000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
