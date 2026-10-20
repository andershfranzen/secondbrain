import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Database, one } from "./index.js";
import { migrationManifest } from "./manifest.js";
export async function migrate(url: string, directory?: string) {
  const db = new Database(url),
    c = await db.pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(73522101)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const { name, sql, sha256: checksum } of await migrationManifest(
      directory,
    )) {
      const old = await one(
        c,
        "SELECT sha256 FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (old) {
        if (old.sha256 !== checksum)
          throw new Error(`Migration checksum changed: ${name}`);
        continue;
      }
      try {
        await c.query("BEGIN");
        await c.query(
          sql.replace(/^BEGIN;\s*$/gm, "").replace(/^COMMIT;\s*$/gm, ""),
        );
        await c.query(
          "INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)",
          [name, checksum],
        );
        await c.query("COMMIT");
        console.log(`Applied ${name}`);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(73522101)");
    c.release();
    await db.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await migrate(process.env.DATABASE_URL ?? "");
