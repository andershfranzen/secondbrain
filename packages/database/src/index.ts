import pg from "pg";
import { hash, chunks } from "@secondbrain/shared";
export { migrationManifest } from "./manifest.js";
// SQL DATE is a calendar date, not midnight in the server's local timezone.
// Keeping it as YYYY-MM-DD prevents Copenhagen deadlines shifting to the
// previous UTC day in API responses, exports and exact-assertion comparisons.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
export type Row = Record<string, any>;
export interface Queryable {
  query<T extends pg.QueryResultRow = Row>(
    text: string,
    values?: any[],
  ): Promise<pg.QueryResult<T>>;
}
export class Database implements Queryable {
  pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 12 });
  }
  query<T extends pg.QueryResultRow = Row>(text: string, values?: any[]) {
    return this.pool.query<T>(text, values);
  }
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock_shared(73522102)");
      const value = await fn(c);
      await c.query("COMMIT");
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
export async function one<T extends pg.QueryResultRow = Row>(
  db: Queryable,
  sql: string,
  values: any[] = [],
): Promise<T | undefined> {
  return (await db.query<T>(sql, values)).rows[0];
}
export async function enqueue(
  db: Queryable,
  kind: string,
  key: string,
  conversationId: string | null,
  payload: unknown = {},
  parentId: string | null = null,
) {
  const { inserted, ...job } = (await one(
    db,
    `INSERT INTO processing_jobs(kind,dedupe_key,conversation_id,payload,parent_job_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *,(xmax=0) AS inserted`,
    [kind, key, conversationId, JSON.stringify(payload), parentId],
  ))!;
  // A new job wakes the worker when the transaction commits; its poll is the
  // fallback. Only a new one: the worker re-enqueues recurring jobs every pass.
  if (inserted) await db.query(`SELECT pg_notify($1,'')`, [jobsChannel]);
  return job;
}
export const jobsChannel = "processing_jobs";
export async function indexText(
  db: Queryable,
  target: { sourceId?: string; itemId?: string; revision?: number },
  text: string,
) {
  if (target.itemId)
    await db.query(`DELETE FROM embeddings WHERE item_id=$1`, [target.itemId]);
  for (const [i, c] of chunks(text).entries())
    await db.query(
      `INSERT INTO embeddings(source_id,item_id,item_revision,model,input_sha256,chunk_index,start_offset,end_offset,content) VALUES($1,$2,$3,'lexical-v1',$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        target.sourceId ?? null,
        target.itemId ?? null,
        target.revision ?? null,
        hash(c.content),
        i,
        c.start,
        c.end,
        c.content,
      ],
    );
}
export function camel<T = Row>(value: any): T {
  if (value instanceof Date) return value.toISOString() as T;
  if (Array.isArray(value)) return value.map((v) => camel(v)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        camel(v),
      ]),
    ) as T;
  return value;
}
