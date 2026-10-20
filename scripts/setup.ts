import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { stdin, stdout } from "node:process";
import argon2 from "argon2";
if (!stdin.isTTY)
  throw new Error(
    "Run setup in an interactive terminal; passwords must not be passed as command arguments.",
  );
async function hidden(prompt: string) {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let text = "";
  return new Promise<string>((resolve, reject) => {
    const onData = (b: Buffer) => {
      for (const ch of b.toString()) {
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(text);
          return;
        }
        if (ch === "\u007f") text = text.slice(0, -1);
        else text += ch;
      }
    };
    function cleanup() {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    }
    stdin.on("data", onData);
  });
}
const password = await hidden(
    "New application password (at least 12 characters): ",
  ),
  confirm = await hidden("Confirm password: ");
if (password !== confirm || password.length < 12)
  throw new Error("Passwords must match and contain at least 12 characters.");
const dir = resolve(process.env.DATA_DIR ?? "./data");
await mkdir(join(dir, "secrets"), { recursive: true, mode: 0o700 });
await writeFile(
  join(dir, "secrets", "password.hash"),
  await argon2.hash(password, { type: argon2.argon2id }),
  { mode: 0o600, flag: "wx" },
);
if (process.argv.includes("--password-only")) {
  console.log("Password hash saved privately.");
  process.exit(0);
}
let env = "";
try {
  env = await readFile(".env", "utf8");
} catch {
  env = await readFile(".env.example", "utf8");
}
if (!/^SESSION_SECRET=.+/m.test(env))
  env = env.replace(
    /^SESSION_SECRET=.*$/m,
    `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
  );
await writeFile(".env", env, { mode: 0o600 });
console.log(
  "Password hash and session secret saved privately. Configure database and provider settings in .env.",
);
