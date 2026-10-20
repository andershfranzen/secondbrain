import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  chatgptIssuer,
  chatgptResource,
  readChatGPTCredentials,
  writeProtectedJSON,
  verifyChatGPTIdentity,
  tokenExpiry,
  ChatGPTCredentials,
  withCredentialLock,
  readChatGPTRegistration,
  retainChatGPTRegistration,
} from "./chatgpt-auth.js";

export async function connectChatGPT(
  path: string,
  abort: AbortSignal,
  onReady: (url: URL, port: number) => void,
) {
  const hostPath = `${path}.host.json`;
  await withCredentialLock(path, abort, async () => {
    let host: string;
    try {
      host = z
        .object({ id: z.string().regex(/^urn:uuid:/) })
        .parse(JSON.parse(await readFile(hostPath, "utf8"))).id;
    } catch {
      host = `urn:uuid:${randomUUID()}`;
      await writeProtectedJSON(hostPath, { id: host });
    }
    const active = await readChatGPTCredentials(path).catch(() => null);
    const old = active ?? (await readChatGPTRegistration(path));
    if (old && old.ext_agent_host_id !== host)
      throw new Error("CHATGPT_HOST_MISMATCH");
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(64).toString("base64url");
    let completing = false;
    let finish: (error?: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = (error) => (error ? reject(error) : resolve());
    });
    const server = createServer(async (req, res) => {
      res.setHeader("cache-control", "no-store");
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const callback = new URL(req.url ?? "/", "http://127.0.0.1");
      if (
        callback.pathname !== "/auth/callback" ||
        callback.searchParams.get("state") !== state ||
        completing
      ) {
        res.writeHead(400).end("Invalid or expired sign-in attempt.");
        return;
      }
      completing = true;
      try {
        if (callback.searchParams.has("error"))
          throw new Error("CHATGPT_SIGN_IN_DECLINED");
        const issued = callback.searchParams.get("client_id") ?? old?.client_id;
        if (!issued?.startsWith("oaiapp_") || (old && issued !== old.client_id))
          throw new Error("CHATGPT_REGISTRATION_MISMATCH");
        const code = callback.searchParams.get("code");
        if (!code) throw new Error("CHATGPT_REGISTRATION_INCOMPLETE");
        const response = await fetch(
          `${chatgptIssuer}/api/accounts/oauth/token`,
          {
            method: "POST",
            signal: AbortSignal.timeout(15000),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: issued,
              code,
              code_verifier: verifier,
              redirect_uri: redirect,
              resource: chatgptResource,
            }),
          },
        );
        if (!response.ok) throw new Error("CHATGPT_TOKEN_EXCHANGE_FAILED");
        const tokens = z
          .object({
            access_token: z.string().min(1),
            refresh_token: z.string().min(1),
            id_token: z.string().min(1),
            scope: z.string(),
            expires_in: z.number().positive(),
          })
          .parse(await response.json());
        const identity = await verifyChatGPTIdentity(
          tokens.id_token,
          issued,
          nonce,
        );
        if (old && old.subject !== identity.subject)
          throw new Error("CHATGPT_ACCOUNT_MISMATCH");
        const scopes = tokens.scope.split(/\s+/);
        if (!scopes.includes("chatgpt.tokens.use.direct"))
          throw new Error("CHATGPT_PLAN_PERMISSION_REQUIRED");
        const credentials = ChatGPTCredentials.parse({
          issuer: chatgptIssuer,
          ...identity,
          ...tokens,
          client_id: issued,
          ext_agent_host_id: host,
          scopes,
          expires_at: tokenExpiry(tokens.access_token, tokens.expires_in),
        });
        await retainChatGPTRegistration(path, credentials);
        await writeProtectedJSON(path, credentials);
        res
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end("Second Brain is connected. You can close this tab.");
        finish();
      } catch {
        res
          .writeHead(400, { "content-type": "text/plain" })
          .end(
            "Connection failed. Return to the terminal and start a new sign-in.",
          );
        finish(new Error("CHATGPT_CONNECTION_FAILED"));
      }
    });
    const onAbort = () => finish(new Error("CHATGPT_SIGN_IN_TIMEOUT"));
    abort.addEventListener("abort", onAbort, { once: true });
    abort.throwIfAborted();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const redirect = `http://127.0.0.1:${port}/auth/callback`;
    const url = new URL(`${chatgptIssuer}/api/accounts/authorize`);
    for (const [key, value] of Object.entries({
      client_id: old?.client_id ?? "dynamic_agent_client",
      ext_agent_host_id: host,
      response_type: "code",
      redirect_uri: redirect,
      scope:
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: chatgptResource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...(!old ? { agent_name_hint: "Second Brain" } : {}),
    }))
      url.searchParams.set(key, value);
    onReady(url, port);
    try {
      await done;
    } finally {
      abort.removeEventListener("abort", onAbort);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
