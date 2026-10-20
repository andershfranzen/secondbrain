import "dotenv/config";
import { resolve } from "node:path";
import { connectChatGPT } from "../packages/ai/src/chatgpt-connect.js";
const path = resolve(
  process.env.CHATGPT_CREDENTIALS_PATH ?? "./secrets/chatgpt.json",
);
try {
  await connectChatGPT(path, AbortSignal.timeout(600000), (url, port) => {
    console.log(
      `Open this URL on this computer:\n${url}\n\nIf running over SSH, forward the callback first in another terminal:\nssh -N -L ${port}:127.0.0.1:${port} user@your-server\n`,
    );
  });
  console.log(
    `Connected. Credentials saved privately at ${path}.\nSet AI_PROVIDER=chatgpt and choose an account-supported REASONING_MODEL (run pnpm models:chatgpt). Restart the API and worker, then enable cloud processing in Settings.\nThis connection enables text reasoning; it does not enable transcription or embeddings.`,
  );
} catch {
  console.error(
    "ChatGPT connection did not complete. No token is printed. Check account permission and retry the sign-in command.",
  );
  process.exitCode = 1;
}
