import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";
import { z } from "zod";

export const chatgptIssuer = "https://auth.openai.com";
export const chatgptResource = "https://api.openai.com/v1";
export const ChatGPTCredentials = z.object({
  issuer: z.literal(chatgptIssuer),
  subject: z.string().min(1),
  email: z.string().optional(),
  client_id: z.string().startsWith("oaiapp_"),
  ext_agent_host_id: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
  scopes: z.array(z.string()),
  expires_at: z.number().finite(),
  reauth_required: z.boolean().optional(),
});
export type ChatGPTCredentials = z.infer<typeof ChatGPTCredentials>;
// Non-secret mapping survives sign-out so later sign-ins reuse the registration.
export const ChatGPTRegistration = ChatGPTCredentials.pick({
  issuer: true,
  subject: true,
  client_id: true,
  ext_agent_host_id: true,
});
export async function readChatGPTRegistration(path: string) {
  try {
    return ChatGPTRegistration.parse(
      JSON.parse(await readFile(`${path}.registration.json`, "utf8")),
    );
  } catch {
    return null;
  }
}
export async function retainChatGPTRegistration(
  path: string,
  credentials: ChatGPTCredentials,
) {
  await writeProtectedJSON(
    `${path}.registration.json`,
    ChatGPTRegistration.parse(credentials),
  );
}
export class ChatGPTAuthError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export async function readChatGPTCredentials(path: string) {
  try {
    const info = await stat(path);
    if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
      throw new ChatGPTAuthError("CHATGPT_CREDENTIAL_PERMISSIONS");
    return ChatGPTCredentials.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof ChatGPTAuthError) throw error;
    throw new ChatGPTAuthError("CHATGPT_CONNECTION_REQUIRED");
  }
}
export async function writeProtectedJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
const jwks = createRemoteJWKSet(
  new URL("/.well-known/jwks.json", chatgptIssuer),
);
export async function verifyChatGPTIdentity(
  token: string,
  clientId: string,
  nonce?: string,
) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: chatgptIssuer,
    audience: clientId,
    requiredClaims: ["sub", "exp", "iat"],
    clockTolerance: 5,
  });
  if (nonce !== undefined && payload.nonce !== nonce)
    throw new ChatGPTAuthError("CHATGPT_NONCE_MISMATCH");
  return {
    subject: payload.sub!,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
  };
}
export function tokenExpiry(
  accessToken: string,
  expiresIn: number,
  now = Date.now(),
) {
  let expiry = now + expiresIn * 1000;
  try {
    const exp = decodeJwt(accessToken).exp;
    if (typeof exp === "number") expiry = Math.min(expiry, exp * 1000);
  } catch {
    /* Opaque tokens use the server's expiry. */
  }
  return expiry;
}
/** Cross-process lock: the API and worker must not race a rotating refresh token. */
export async function withCredentialLock<T>(
  path: string,
  signal: AbortSignal,
  run: () => Promise<T>,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`,
    deadline = Date.now() + 25000;
  let handle;
  while (!handle) {
    signal.throwIfAborted();
    try {
      handle = await open(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 60000) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new ChatGPTAuthError("CHATGPT_REFRESH_BUSY");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void handle!.utimes(now, now).catch(() => {});
  }, 10000);
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    await handle.close();
    await rm(lock, { force: true });
  }
}
export async function chatgptAccessToken(
  path: string,
  signal: AbortSignal,
  rejectedToken?: string,
) {
  const initial = await readChatGPTCredentials(path);
  const valid = (record: ChatGPTCredentials) =>
    record.access_token !== rejectedToken &&
    !record.reauth_required &&
    record.scopes.includes("chatgpt.tokens.use.direct") &&
    record.expires_at > Date.now() + 60000;
  if (valid(initial)) return initial.access_token;
  return withCredentialLock(path, signal, async () => {
    const record = await readChatGPTCredentials(path);
    if (record.reauth_required)
      throw new ChatGPTAuthError("CHATGPT_REAUTH_REQUIRED");
    if (!record.scopes.includes("chatgpt.tokens.use.direct"))
      throw new ChatGPTAuthError("CHATGPT_PLAN_PERMISSION_REQUIRED");
    if (valid(record)) return record.access_token;
    const response = await fetch(`${chatgptIssuer}/api/accounts/oauth/token`, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: record.client_id,
        refresh_token: record.refresh_token,
        resource: chatgptResource,
      }),
    }).catch(() => {
      throw new ChatGPTAuthError("CHATGPT_REFRESH_UNAVAILABLE");
    });
    if (!response.ok) {
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        await writeProtectedJSON(path, { ...record, reauth_required: true });
        throw new ChatGPTAuthError("CHATGPT_REAUTH_REQUIRED");
      }
      throw new ChatGPTAuthError("CHATGPT_REFRESH_UNAVAILABLE");
    }
    let tokens;
    try {
      tokens = z
        .object({
          access_token: z.string().min(1),
          refresh_token: z.string().min(1),
          expires_in: z.number().positive(),
          scope: z.string().optional(),
          id_token: z.string().optional(),
        })
        .parse(await response.json());
      if (tokens.id_token) {
        const identity = await verifyChatGPTIdentity(
          tokens.id_token,
          record.client_id,
        );
        if (identity.subject !== record.subject)
          throw new ChatGPTAuthError("CHATGPT_ACCOUNT_MISMATCH");
      }
    } catch {
      // A successful exchange may already have rotated the refresh token. Do
      // not replay the old one after an invalid response or identity change.
      await writeProtectedJSON(path, { ...record, reauth_required: true });
      throw new ChatGPTAuthError("CHATGPT_REAUTH_REQUIRED");
    }
    const next = ChatGPTCredentials.parse({
      ...record,
      ...tokens,
      scopes: tokens.scope?.split(/\s+/) ?? record.scopes,
      expires_at: tokenExpiry(tokens.access_token, tokens.expires_in),
    });
    await writeProtectedJSON(path, next);
    if (!next.scopes.includes("chatgpt.tokens.use.direct"))
      throw new ChatGPTAuthError("CHATGPT_PLAN_PERMISSION_REQUIRED");
    return next.access_token;
  });
}
