import type { Queue } from "bullmq";
import type { Queryable } from "@secondbrain/database";

/** Redis is delivery only. Reconstruct every due delivery from PostgreSQL. */
export async function dispatchDueJobs(
  db: Queryable,
  queue: Pick<Queue, "getJob" | "add">,
) {
  const jobs = (
    await db.query(
      `SELECT id FROM processing_jobs WHERE status IN('pending','retry_wait') AND run_after<=now() AND blocked_reason IS NULL ORDER BY created_at,id LIMIT 100`,
    )
  ).rows;
  for (const job of jobs) {
    const old = await queue.getJob(job.id);
    if (old && ((await old.isCompleted()) || (await old.isFailed())))
      await old.remove();
    await queue.add(
      "process",
      {},
      {
        jobId: job.id,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 1,
      },
    );
  }
  return jobs.length;
}
