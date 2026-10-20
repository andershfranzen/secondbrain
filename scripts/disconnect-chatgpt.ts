import "dotenv/config";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  readChatGPTCredentials,
  withCredentialLock,
  chatgptIssuer,
  retainChatGPTRegistration,
} from "../packages/ai/src/chatgpt-auth.js";
const path = resolve(
  process.env.CHATGPT_CREDENTIALS_PATH ?? "./secrets/chatgpt.json",
);
try {
  const signal = AbortSignal.timeout(30000);
  await withCredentialLock(path, signal, async () => {
    const credentials = await readChatGPTCredentials(path);
    const discovery = await fetch(
      `${chatgptIssuer}/.well-known/openid-configuration`,
      { signal },
    );
    if (!discovery.ok) throw new Error("DISCOVERY_UNAVAILABLE");
    const { revocation_endpoint } = z
      .object({ revocation_endpoint: z.url() })
      .parse(await discovery.json());
    if (new URL(revocation_endpoint).origin !== chatgptIssuer)
      throw new Error("INVALID_REVOCATION_ENDPOINT");
    const response = await fetch(revocation_endpoint, {
      method: "POST",
      signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: credentials.refresh_token,
        token_type_hint: "refresh_token",
        client_id: credentials.client_id,
      }),
    });
    if (response.status !== 200) throw new Error("REVOCATION_UNCONFIRMED");
    await retainChatGPTRegistration(path, credentials);
    await rm(path);
    console.log(
      "ChatGPT session revoked and local credentials removed. The stable host ID is retained.",
    );
  });
} catch {
  console.error(
    "Remote revocation was not confirmed. Credentials were retained so you can retry, or disconnect Second Brain in ChatGPT Settings.",
  );
  process.exitCode = 1;
}
