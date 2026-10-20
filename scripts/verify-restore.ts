import { createReadStream } from "node:fs";
/** Isolated operational smoke test. Run in the application image with pg17 + restic. */
import { mkdtemp, writeFile, readdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Database, one } from "@secondbrain/database";
import { config, randomUUID, hash } from "@secondbrain/shared";
import { migrate } from "../packages/database/src/migrate.js";
import {
  captureText,
  captureAudio,
  privatePath,
  requestDeletion,
} from "@secondbrain/memory";
import { backup, restore, command } from "./operations.js";
const base = new URL(
  process.env.TEST_DATABASE_URL ??
    "postgres://postgres:integration-only@127.0.0.1:55432/postgres",
);
base.pathname = "/postgres";
if (base.hostname !== "127.0.0.1" || base.port !== "55432")
  throw new Error("Use the isolated local test PostgreSQL on port 55432.");
const admin = new Database(base.toString()),
  suffix = randomUUID().replaceAll("-", ""),
  names = [`backup_test_${suffix}`, `restore_test_${suffix}`],
  root = await mkdtemp(join(tmpdir(), "sb-restore-"));
const databases: Database[] = [];
try {
  for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
  const url = (name: string) => {
    const u = new URL(base);
    u.pathname = "/" + name;
    return u.toString();
  };
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = url(names[0]!);
  process.env.DATA_DIR = join(root, "data");
  process.env.ERASURE_MANIFEST_PATH = join(root, "erasures", "manifest.jsonl");
  process.env.SESSION_SECRET = "operational-test-session-secret-over-32-bytes";
  process.env.AI_PROVIDER = "none";
  process.env.RESTIC_REPOSITORY = join(root, "restic");
  process.env.RESTIC_PASSWORD_FILE = join(root, "restic-password");
  await writeFile(process.env.RESTIC_PASSWORD_FILE, randomUUID(), {
    mode: 0o600,
  });
  await command("restic", ["init"]);
  await migrate(process.env.DATABASE_URL);
  const db = new Database(process.env.DATABASE_URL);
  databases.push(db);
  await db.query(
    "INSERT INTO app_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING",
  );
  const kept = await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "A retained operational test thought.",
    }),
    erased = await captureText(db, {
      clientCaptureId: randomUUID(),
      text: "This thought must not return after restore.",
    });
  const audioPath = join(root, "fixture.wav");
  await command("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    "1",
    audioPath,
  ]);
  await captureAudio(
    db,
    config(),
    createReadStream(audioPath),
    randomUUID(),
    "audio/wav",
  );
  await db.query(
    "INSERT INTO sessions(token_hash,csrf_token_hash,expires_at) VALUES('test-token-hash','test-csrf-hash',now()+interval '1 hour')",
  );
  await backup();
  await db.transaction((tx) =>
    requestDeletion(tx, erased.conversation.id, config()),
  );
  const target = join(root, "unpacked");
  await command("restic", ["restore", "latest", "--target", target]);
  async function locate(dir: string): Promise<string | undefined> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === "manifest.json") return dir;
      if (e.isDirectory()) {
        const match = await locate(join(dir, e.name));
        if (match) return match;
      }
    }
  }
  const bundle = await locate(target);
  assert.ok(bundle);
  process.env.DATABASE_URL = url(names[1]!);
  process.env.DATA_DIR = join(root, "restored-data");
  await restore(bundle);
  const restored = new Database(process.env.DATABASE_URL);
  databases.push(restored);
  assert.ok(
    await one(restored, "SELECT id FROM conversations WHERE id=$1", [
      kept.conversation.id,
    ]),
  );
  assert.equal(
    await one(restored, "SELECT id FROM conversations WHERE id=$1", [
      erased.conversation.id,
    ]),
    undefined,
  );
  assert.equal(
    (await one(restored, "SELECT count(*)::int AS n FROM sessions"))!.n,
    0,
  );
  assert.equal(
    (await one(restored, "SELECT maintenance FROM app_settings"))!.maintenance,
    false,
  );
  const attachment = (await one(restored, "SELECT * FROM attachments"))!;
  assert.equal(
    hash(await readFile(privatePath(config(), attachment.storage_key))),
    attachment.sha256,
  );
  await assert.rejects(() => restore(bundle), /empty isolated database/);
  console.log(
    "PASS: encrypted backup, isolated restore, independent erasure replay, attachment integrity, session revocation and nonempty restore refusal.",
  );
} finally {
  for (const db of databases) await db.close();
  for (const name of names)
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.close();
  await rm(root, { recursive: true, force: true });
}
