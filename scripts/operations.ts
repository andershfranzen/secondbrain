import "dotenv/config";
import {
  mkdir,
  mkdtemp,
  rm,
  copyFile,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Database, one } from "@secondbrain/database";
import { config, randomUUID, hash, z } from "@secondbrain/shared";
import {
  initStorage,
  privatePath,
  requestDeletion,
  purgeConversation,
} from "@secondbrain/memory";
export async function command(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  out?: string,
) {
  const child = spawn(program, args, {
    env,
    stdio: ["ignore", out ? "pipe" : "inherit", "inherit"],
  });
  const copied = out
    ? pipeline(child.stdout!, createWriteStream(out, { mode: 0o600 }))
    : Promise.resolve();
  await Promise.all([
    copied,
    new Promise<void>((done, reject) => {
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? done()
          : reject(new Error(`${program} exited with ${code}`)),
      );
    }),
  ]);
}
export async function backup() {
  const c = config();
  if (!c.RESTIC_REPOSITORY || !c.RESTIC_PASSWORD_FILE)
    throw new Error(
      "Configure RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE; initialize the encrypted repository with restic init first.",
    );
  const db = new Database(c.DATABASE_URL),
    conn = await db.pool.connect(),
    dir = await mkdtemp(join(tmpdir(), "secondbrain-backup-")),
    id = randomUUID();
  try {
    await db.query(
      "INSERT INTO backup_runs(id,kind,status) VALUES($1,'backup','running')",
      [id],
    );
    await db.query("UPDATE app_settings SET maintenance=true");
    await conn.query("SELECT pg_advisory_lock(73522102)");
    const u = new URL(c.DATABASE_URL),
      env = {
        ...process.env,
        PGHOST: u.hostname,
        PGPORT: u.port || "5432",
        PGDATABASE: u.pathname.slice(1),
        PGUSER: decodeURIComponent(u.username),
        PGPASSWORD: decodeURIComponent(u.password),
      };
    await command(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl"],
      env,
      join(dir, "database.dump"),
    );
    const files = (
      await db.query(
        "SELECT id,storage_key,sha256 FROM attachments WHERE state='available'",
      )
    ).rows;
    await mkdir(join(dir, "audio"), { recursive: true, mode: 0o700 });
    for (const f of files) {
      const dest = join(dir, f.storage_key);
      await copyFile(privatePath(c, f.storage_key), dest);
      if (hash(await readFile(dest)) !== f.sha256)
        throw new Error("Attachment integrity check failed");
    }
    await mkdir(dirname(resolve(c.ERASURE_MANIFEST_PATH)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(resolve(c.ERASURE_MANIFEST_PATH), "", {
      flag: "a",
      mode: 0o600,
    });
    const erasures = await readFile(resolve(c.ERASURE_MANIFEST_PATH), "utf8");
    await writeFile(join(dir, "erasures.jsonl"), erasures, { mode: 0o600 });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        format: 1,
        createdAt: new Date().toISOString(),
        attachments: files,
      }),
      { mode: 0o600 },
    );
    await conn.query("SELECT pg_advisory_unlock(73522102)");
    await db.query("UPDATE app_settings SET maintenance=false");
    // Only encrypted restic data leaves this server. The temporary unencrypted
    // bundle is private and removed in finally; a host tmpfs is recommended.
    await command("restic", ["backup", "--tag", "secondbrain", dir]);
    await command("restic", [
      "forget",
      "--tag",
      "secondbrain",
      "--group-by",
      "tags",
      "--keep-daily",
      "7",
      "--keep-weekly",
      "4",
      "--prune",
    ]);
    await db.query(
      "UPDATE backup_runs SET status='succeeded',completed_at=now() WHERE id=$1",
      [id],
    );
  } catch (e) {
    await db.query(
      "UPDATE backup_runs SET status='failed',completed_at=now() WHERE id=$1",
      [id],
    );
    throw e;
  } finally {
    await conn.query("SELECT pg_advisory_unlock(73522102)");
    await db.query("UPDATE app_settings SET maintenance=false");
    conn.release();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
export async function restore(bundle: string) {
  const c = config(),
    db = new Database(c.DATABASE_URL);
  try {
    await initStorage(c);
    // Restore is an operator command for an empty, isolated instance. Never drop
    // existing application data to make a restore fit.
    if (
      await one(
        db,
        "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='conversations'",
      )
    )
      throw new Error(
        "Restore requires an empty isolated database. Stop the application and use a new database/volume.",
      );
    const root = resolve(bundle),
      manifest = z
        .object({
          format: z.literal(1),
          createdAt: z.string(),
          attachments: z.array(
            z.object({
              id: z.uuid(),
              storage_key: z.string(),
              sha256: z.string(),
            }),
          ),
        })
        .parse(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
    let independent = "";
    try {
      independent = await readFile(resolve(c.ERASURE_MANIFEST_PATH), "utf8");
    } catch {
      throw new Error(
        "The independent erasure manifest must be available before restoring. An empty manifest must be provisioned explicitly for a never-used installation.",
      );
    }
    const u = new URL(c.DATABASE_URL),
      env = {
        ...process.env,
        PGHOST: u.hostname,
        PGPORT: u.port || "5432",
        PGDATABASE: u.pathname.slice(1),
        PGUSER: decodeURIComponent(u.username),
        PGPASSWORD: decodeURIComponent(u.password),
      };
    await command(
      "pg_restore",
      [
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "--dbname",
        u.pathname.slice(1),
        join(root, "database.dump"),
      ],
      env,
    );
    await db.query("UPDATE app_settings SET maintenance=true");
    for (const a of manifest.attachments) {
      const src = join(root, a.storage_key),
        target = privatePath(c, a.storage_key);
      if (!src.startsWith(root + "/"))
        throw new Error("Invalid backup storage key");
      if (hash(await readFile(src)) !== a.sha256)
        throw new Error("Backup attachment integrity check failed");
      await copyFile(src, target);
    }
    const included = await readFile(join(root, "erasures.jsonl"), "utf8"),
      erased = new Set<string>();
    for (const line of (included + "\n" + independent)
      .split("\n")
      .filter(Boolean))
      erased.add(
        z
          .object({ conversationId: z.uuid(), requestedAt: z.string() })
          .parse(JSON.parse(line)).conversationId,
      );
    for (const id of erased)
      if (await one(db, "SELECT id FROM conversations WHERE id=$1", [id]))
        await db.transaction(async (tx) => {
          await requestDeletion(tx, id);
          await purgeConversation(tx, c, id);
        });
    await db.query(
      `UPDATE processing_jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'retry_wait' END,lease_token=NULL,lease_until=NULL,run_after=now() WHERE status='running'`,
    );
    await db.query("DELETE FROM sessions");
    await db.query("DELETE FROM attachment_pins");
    await db.query("UPDATE app_settings SET maintenance=false");
    await db.query(
      "INSERT INTO backup_runs(kind,status,completed_at) VALUES('restore','succeeded',now())",
    );
    console.log(
      `Restored ${manifest.createdAt}; applied ${erased.size} independent erasures. Configure the password/provider secrets before starting the isolated instance.`,
    );
  } finally {
    await db.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "backup") await backup();
  else if (process.argv[2] === "restore" && process.argv[3])
    await restore(process.argv[3]);
  else
    throw new Error(
      "Usage: pnpm ops backup | pnpm ops restore /path/to/restored-bundle",
    );
}
