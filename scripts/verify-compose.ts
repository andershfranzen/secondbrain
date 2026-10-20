/** Build the image first. Uses only an isolated Compose project and temporary volumes. */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import argon2 from "argon2";
const dir = await mkdtemp(join(tmpdir(), "sb-compose-")),
  name = "sb-check-" + randomBytes(4).toString("hex"),
  port = 53000 + Math.floor(Math.random() * 1000),
  password = randomBytes(24).toString("hex");
for (const folder of ["erasures", "backups"])
  await mkdir(join(dir, folder), { mode: 0o700 });
const env = join(dir, "validation.env"),
  override = join(dir, "override.yaml");
await writeFile(
  env,
  `POSTGRES_PASSWORD=${password}\nAPP_ORIGIN=https://validation.invalid\nSESSION_SECRET=${randomBytes(32).toString("hex")}\nAI_PROVIDER=none\nAUTH_PASSWORD_HASH='${await argon2.hash("isolated-compose-password")}'\nERASURE_DIRECTORY=${dir}/erasures\nBACKUP_DIRECTORY=${dir}/backups\n`,
  { mode: 0o600 },
);
await writeFile(
  override,
  `services:\n` +
    ["migrate", "api", "worker", "web", "operations"]
      .map(
        (service) =>
          `  ${service}:\n    env_file: !override [${JSON.stringify(env)}]\n` +
          (service === "web"
            ? `    ports: !override ["127.0.0.1:${port}:3000"]\n`
            : ""),
      )
      .join(""),
  { mode: 0o600 },
);
async function compose(args: string[]) {
  const child = spawn(
    "docker",
    [
      "compose",
      "--env-file",
      env,
      "-p",
      name,
      "-f",
      resolve("infrastructure/compose.production.yaml"),
      ...(process.env.VERIFY_CHATGPT === "1"
        ? ["-f", resolve("infrastructure/compose.chatgpt.yaml")]
        : []),
      "-f",
      override,
      ...args,
    ],
    { stdio: "inherit" },
  );
  await new Promise<void>((done, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? done()
        : reject(new Error("Compose command failed: " + args[0])),
    );
  });
}
try {
  await compose(["config", "--quiet"]);
  await compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "90"]);
  if (process.env.VERIFY_CHATGPT === "1") {
    await compose([
      "run",
      "--rm",
      "--no-deps",
      "chatgpt-connect",
      "node",
      "--input-type=module",
      "-e",
      'import {writeFile,stat,rm} from "node:fs/promises"; const p="/chatgpt-auth/validation-only"; await writeFile(p,"synthetic-auth-volume-check",{mode:0o600}); if(((await stat(p)).mode & 0o777)!==0o600) process.exit(1); await rm(p); console.log("PASS: isolated subscription auth volume is writable with owner-only files.");',
    ]);
    await compose([
      "exec",
      "-T",
      "api",
      "node",
      "-e",
      'if(process.env.AI_PROVIDER!=="chatgpt" || process.env.CHATGPT_CREDENTIALS_PATH!=="/chatgpt-auth/connection.json") process.exit(1)',
    ]);
  }
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("Second Brain"));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/me`)).status, 401);
  console.log(
    "PASS: production image, migrations, health checks, web/API proxy and authentication boundary.",
  );
} finally {
  await compose(["down", "--volumes", "--remove-orphans"]);
  await rm(dir, { recursive: true, force: true });
}
