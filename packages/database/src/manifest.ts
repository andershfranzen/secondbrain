import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { hash } from "@secondbrain/shared";

export async function migrationManifest(
  directory = fileURLToPath(new URL("../migrations/", import.meta.url)),
) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(directory, name), "utf8");
      return { name, sql, sha256: hash(sql) };
    }),
  );
}
