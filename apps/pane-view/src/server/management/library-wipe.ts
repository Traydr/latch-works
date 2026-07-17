import { eq, isNull } from "drizzle-orm";
import { assertSyncApiTokenFromBody } from "../auth/api-token";
import { db } from "../db";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import {
  collectionItems,
  collections,
  favorites,
  folders,
  libraryEntries,
  maintenanceJobs,
  viewerState,
} from "../db/schema";
import { processMaintenanceJob } from "./cleanup-worker";
import { assertNoActiveSyncRun, readActiveCleanupJob } from "./guards";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

export async function scheduleLibraryWipe({
  confirmation,
  syncToken,
}: {
  confirmation: string;
  syncToken: string;
}): Promise<{ jobId: string; phase: "scheduled" }> {
  if (confirmation !== "WIPE LIBRARY") {
    throw new Error('Type "WIPE LIBRARY" to confirm.');
  }

  assertSyncApiTokenFromBody(syncToken);

  let jobId: string;
  try {
    jobId = await db.transaction(async (tx) => {
      await acquireLibraryMutationStartupLock(tx);
      await assertNoActiveSyncRun(tx);

      const activeCleanupJob = await readActiveCleanupJob(tx);
      if (activeCleanupJob) {
        throw new Error("A library wipe cleanup job is already in progress.");
      }

      const now = new Date();

      await tx.update(libraryEntries).set({ deletedAt: now }).where(isNull(libraryEntries.deletedAt));
      await tx.update(folders).set({ deletedAt: now }).where(isNull(folders.deletedAt));
      await tx.delete(collectionItems);
      await tx.delete(collections);
      await tx.delete(favorites).where(eq(favorites.subjectType, "library_entry"));
      await tx.delete(viewerState).where(eq(viewerState.subjectType, "library_entry"));

      const [job] = await tx
        .insert(maintenanceJobs)
        .values({
          progress: {
            errorCount: 0,
            phase: "s3_originals",
            processedCount: 0,
          },
          status: "pending",
          type: "library_hard_wipe",
        })
        .returning({ id: maintenanceJobs.id });

      if (!job) {
        throw new Error("Unable to schedule library wipe.");
      }

      return job.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("A library wipe cleanup job is already in progress.");
    }
    throw error;
  }

  processMaintenanceJob(jobId);

  return {
    jobId,
    phase: "scheduled",
  };
}
