import { isNotNull } from "drizzle-orm";
import { db } from "../db";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { libraryEntries, maintenanceJobs } from "../db/schema";
import { processMaintenanceJob } from "./cleanup-worker";
import { assertNoActiveSyncRun, readActiveCleanupJob } from "./guards";

export async function scheduleSoftDeletedPurge(): Promise<{
  jobId: string | null;
  phase: "empty" | "scheduled";
}> {
  const jobId = await db.transaction(async (tx) => {
    await acquireLibraryMutationStartupLock(tx);
    await assertNoActiveSyncRun(tx);

    if (await readActiveCleanupJob(tx)) {
      throw new Error("A cleanup job is already in progress.");
    }

    const [softDeletedEntry] = await tx
      .select({ id: libraryEntries.id })
      .from(libraryEntries)
      .where(isNotNull(libraryEntries.deletedAt))
      .limit(1);

    if (!softDeletedEntry) return null;

    const [job] = await tx
      .insert(maintenanceJobs)
      .values({
        progress: {
          errorCount: 0,
          phase: "orphaned_media",
          processedCount: 0,
        },
        status: "pending",
        type: "soft_deleted_purge",
      })
      .returning({ id: maintenanceJobs.id });

    if (!job) throw new Error("Unable to schedule deleted-item cleanup.");
    return job.id;
  });

  if (!jobId) return { jobId: null, phase: "empty" };

  processMaintenanceJob(jobId);
  return { jobId, phase: "scheduled" };
}
