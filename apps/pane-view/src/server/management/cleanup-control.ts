import { and, eq, inArray } from "drizzle-orm";
import { type Database, db } from "../db";
import { acquireMaintenanceJobClaim } from "../db/library-coordination-lock";
import { maintenanceJobs } from "../db/schema";

/**
 * Cancel an active job. The cancel waits for the job's claim first: a batch in
 * progress may have an object-storage delete or a Shutter purge in flight, and
 * the job must keep blocking syncs until those requests have settled. Once the
 * claim is held no batch is running, so the terminal state is safe to expose.
 */
export async function cancelMaintenanceJob(
  { jobId }: { jobId: string },
  database: Database = db,
): Promise<{ cancelled: boolean }> {
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
