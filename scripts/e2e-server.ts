import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import argon2 from "argon2";
import { Database, one } from "@secondbrain/database";
import { migrate } from "../packages/database/src/migrate.js";
const url =
  process.env.E2E_DATABASE_URL ??
  "postgres://postgres:integration-only@127.0.0.1:55432/secondbrain_e2e";
const u = new URL(url),
  name = u.pathname.slice(1);
if (!name.includes("e2e")) throw new Error("Use a dedicated e2e database");
u.pathname = "/postgres";
const admin = new Database(u.toString());
if (!(await one(admin, "SELECT 1 FROM pg_database WHERE datname=$1", [name])))
  await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
await admin.close();
await migrate(url);
const db = new Database(url),
  tables = (
    await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'",
    )
  ).rows;
await db.query(
  "TRUNCATE " + tables.map((t) => `"${t.tablename}"`).join(",") + " CASCADE",
);
await db.query(
  "INSERT INTO app_settings(singleton,cloud_consent_at) VALUES(true,now())",
);
await db.close();
const port = Number(process.env.E2E_WEB_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("E2E_WEB_PORT must be a port between 1024 and 65535");
const dir = await mkdtemp(join(tmpdir(), "secondbrain-e2e-")),
  env = {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: url,
    REDIS_URL: "redis://127.0.0.1:56379",
    APP_ORIGIN: `http://localhost:${port}`,
    AI_PROVIDER: "fake",
    AUTH_PASSWORD_HASH: await argon2.hash("e2e-preview-password"),
    SESSION_SECRET: "e2e-only-session-secret-more-than-32-bytes",
    DATA_DIR: dir,
    ERASURE_MANIFEST_PATH: join(dir, "erasures", "manifest.jsonl"),
  };
const children = [
  spawn("node", ["--import", "tsx", "apps/api/src/main.ts"], {
    env,
    stdio: "inherit",
  }),
  spawn("node", ["--import", "tsx", "apps/worker/src/main.ts"], {
    env,
    stdio: "inherit",
  }),
  spawn(
    "node",
    [
      "node_modules/next/dist/bin/next",
      "start",
      "apps/web",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { env: { ...env, NODE_ENV: "production" }, stdio: "inherit" },
  ),
];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const c of children) c.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void close());
for (const child of children)
  child.on("exit", (code) => {
    if (!closing && code) void close();
  });
