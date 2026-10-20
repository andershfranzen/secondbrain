import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";
import {
  chatgptAccessToken,
  chatgptResource,
} from "../packages/ai/src/chatgpt-auth.js";
try {
  const signal = AbortSignal.timeout(30000);
  const token = await chatgptAccessToken(
    resolve(process.env.CHATGPT_CREDENTIALS_PATH ?? "./secrets/chatgpt.json"),
    signal,
  );
  const response = await fetch(`${chatgptResource}/models`, {
    signal,
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("MODEL_LIST_UNAVAILABLE");
  const result = z
    .object({
      models: z.array(
        z.object({
          slug: z.string(),
          display_name: z.string(),
          visibility: z.string(),
        }),
      ),
    })
    .parse(await response.json());
  for (const model of result.models.filter(
    (model) => model.visibility === "list",
  ))
    console.log(`${model.slug}\t${model.display_name}`);
} catch {
  console.error(
    "Could not list this connection's models. Reconnect if authorization expired.",
  );
  process.exitCode = 1;
}
