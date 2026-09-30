import { and, eq, inArray } from "drizzle-orm";
import { type Database, db } from "../db";
import { acquireMaintenanceJobClaim } from "../db/library-coordination-lock";
import { maintenanceJobs } from "../db/schema";

/** Cancels of each job this process is waiting on, keyed by job id. */
const pendingCancels = new Map<string, Promise<{ cancelled: boolean }>>();

/**
 * Cancel an active job. The cancel waits for the job's claim first: a batch in
 * progress may have an object-storage delete or a Shutter purge in flight, and
 * the job must keep blocking syncs until those requests have settled. Once the
 * claim is held no batch is running, so the terminal state is safe to expose.
 *
 * The wait holds a pooled connection, and the batch it waits on needs pooled
 * connections to finish. Overlapping cancels of one job therefore share a
 * single wait, so repeated requests cannot drain the pool the batch needs.
 */
export function cancelMaintenanceJob(
  { jobId }: { jobId: string },
  database: Database = db,
): Promise<{ cancelled: boolean }> {
  const pending = pendingCancels.get(jobId);

  if (pending) return pending;

  const cancel = cancelOnceClaimed(jobId, database).finally(() => {
    pendingCancels.delete(jobId);
  });

  pendingCancels.set(jobId, cancel);

  return cancel;
}

function cancelOnceClaimed(jobId: string, database: Database): Promise<{ cancelled: boolean }> {
  return database.transaction(async (tx) => {
    await acquireMaintenanceJobClaim(tx, jobId);

    const [job] = await tx
      .update(maintenanceJobs)
      .set({
        completedAt: new Date(),
        error: null,
        status: "cancelled",
      })
      .where(
        and(eq(maintenanceJobs.id, jobId), inArray(maintenanceJobs.status, ["pending", "running"])),
      )
      .returning({ id: maintenanceJobs.id });

    return { cancelled: Boolean(job) };
  });
}
