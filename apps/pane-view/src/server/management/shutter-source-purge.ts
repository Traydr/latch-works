import { and, eq, exists, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { db } from "../db";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { libraryEntries, maintenanceJobs, mediaObjects, shutterSourceCleanup } from "../db/schema";
import { processMaintenanceJob } from "./cleanup-worker";
import { assertNoActiveSyncRun, readActiveCleanupJob } from "./guards";

export async function scheduleShutterSourcePurge(): Promise<{
  jobId: string | null;
  phase: "empty" | "scheduled";
}> {
  const jobId = await db.transaction(async (tx) => {
    await acquireLibraryMutationStartupLock(tx);
    await assertNoActiveSyncRun(tx);

    if (await readActiveCleanupJob(tx)) {
      throw new Error("A cleanup job is already in progress.");
    }

    const [queuedSource] = await tx
      .select({ sha256: shutterSourceCleanup.sha256 })
      .from(shutterSourceCleanup)
      .where(isNull(shutterSourceCleanup.purgedAt))
      .limit(1);

    let hasSource = Boolean(queuedSource);
    if (!hasSource) {
      const deletedReference = tx
        .select({ value: sql`1` })
        .from(libraryEntries)
        .where(
          and(
            eq(libraryEntries.mediaObjectId, mediaObjects.id),
            isNotNull(libraryEntries.deletedAt),
          ),
        );
      const activeReference = tx
        .select({ value: sql`1` })
        .from(libraryEntries)
        .where(
          and(eq(libraryEntries.mediaObjectId, mediaObjects.id), isNull(libraryEntries.deletedAt)),
        );
      const [eligibleSource] = await tx
        .select({ sha256: mediaObjects.sha256 })
        .from(mediaObjects)
        .where(and(exists(deletedReference), notExists(activeReference)))
        .limit(1);
      hasSource = Boolean(eligibleSource);
    }

    if (!hasSource) return null;

    const [job] = await tx
      .insert(maintenanceJobs)
      .values({
        progress: {
          errorCount: 0,
          phase: "queue_sources",
          processedCount: 0,
        },
        status: "pending",
        type: "shutter_source_purge",
      })
      .returning({ id: maintenanceJobs.id });

    if (!job) throw new Error("Unable to schedule Shutter source cleanup.");
    return job.id;
  });

  if (!jobId) return { jobId: null, phase: "empty" };

  processMaintenanceJob(jobId);
  return { jobId, phase: "scheduled" };
}
