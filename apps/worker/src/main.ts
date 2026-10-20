import { Queue, Worker } from "bullmq";
import { config } from "@secondbrain/shared";
import { Database, one, jobsChannel } from "@secondbrain/database";
import { provider, ProviderError } from "@secondbrain/ai";
import {
  processJob,
  recoverJobs,
  dispatchDueJobs,
  initStorage,
  sweepFiles,
  scheduleBrief,
} from "@secondbrain/memory";
const c = config(),
  db = new Database(c.DATABASE_URL),
  ai = provider(c, async () => {
    const s = await one(
      db,
      "SELECT cloud_consent_at,maintenance FROM app_settings",
    );
    if (!s?.cloud_consent_at)
      throw new ProviderError("CONSENT_REQUIRED", false);
    if (s.maintenance) throw new ProviderError("MAINTENANCE", true);
  }),
  url = new URL(c.REDIS_URL);
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  username: url.username || undefined,
  password: url.password || undefined,
  db: Number(url.pathname.slice(1) || 0),
  ...(url.protocol === "rediss:" ? { tls: {} } : {}),
};
await initStorage(c);
const q = new Queue("secondbrain", {
    connection: { ...connection, maxRetriesPerRequest: 1 },
  }),
  worker = new Worker(
    "secondbrain",
    async (job) => processJob(db, c, ai, job.id!),
    { connection, concurrency: c.WORKER_CONCURRENCY },
  );
let busy = false,
  again = false,
  closed = false,
  lastSweep = 0;
q.on("error", () =>
  console.error("Queue unavailable; durable jobs remain in PostgreSQL."),
);
worker.on("error", () => console.error("Worker queue connection unavailable."));
async function dispatch() {
  if (closed) return;
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  again = false;
  try {
    await recoverJobs(db, ai);
    await scheduleBrief(db, c);
    await dispatchDueJobs(db, q);
    if (Date.now() - lastSweep > 3600000) {
      await sweepFiles(db, c);
      lastSweep = Date.now();
    }
  } catch {
    console.error("Dispatch delayed; database or queue is unavailable.");
  } finally {
    busy = false;
  }
  if (again) void dispatch();
}
/**
 * New jobs notify on commit, so a message starts within moments instead of
 * waiting for the poll. A job that ran dispatches at once too, which starts
 * the next queued turn. The poll stays as the fallback.
 */
let listener: { release(destroy?: boolean): void } | null = null;
async function listen() {
  if (closed) return;
  const client = await db.pool.connect().catch(() => null);
  if (!client) {
    setTimeout(() => void listen(), 5000);
    return;
  }
  listener = client;
  let dropped = false;
  const retry = () => {
    if (dropped) return;
    dropped = true;
    listener = null;
    client.release(true);
    setTimeout(() => void listen(), 5000);
  };
  client.on("notification", () => void dispatch());
  client.once("error", retry);
  await client.query(`LISTEN ${jobsChannel}`).catch(retry);
}
worker.on("completed", (_job, ran) => {
  if (ran !== false) void dispatch();
});
const timer = setInterval(() => void dispatch(), 5000);
await listen();
await dispatch();
async function shutdown() {
  closed = true;
  clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 30000);
  await worker.close();
  await q.close();
  listener?.release(true);
  await db.close();
  clearTimeout(deadline);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
