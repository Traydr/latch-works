import { deleteStoredObjectsBatch, listStoredObjectsByPrefix } from "@latch-works/media-storage";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  favorites,
  folders,
  type LibraryWipeJobProgress,
  libraryEntries,
  type MaintenanceJobProgress,
  maintenanceJobs,
  mediaObjects,
  syncRunItems,
  syncRuns,
  viewerState,
} from "../db/schema";
import { purgeShutterSource } from "../media/shutter-client";
import { createPaneViewStorageClient } from "../media/storage-client";

const batchSize = 100;
const maxBatchDurationMs = 2_000;

const orphanPrefixes = ["originals/"] as const;

const activeJobStatuses = ["pending", "running"] as const;

let resumeStarted = false;
const runningJobs = new Set<string>();

export interface CleanupJobStatus {
  completedAt: string | null;
  error: string | null;
  id: string;
  progress: LibraryWipeJobProgress;
  startedAt: string | null;
  status: "pending" | "running" | "completed" | "failed";
  type: "library_hard_wipe";
}

export async function readCleanupJobStatus({
  jobId,
}: {
  jobId: string;
}): Promise<CleanupJobStatus | null> {
  const [job] = await db
    .select({
      completedAt: maintenanceJobs.completedAt,
      error: maintenanceJobs.error,
      id: maintenanceJobs.id,
      progress: maintenanceJobs.progress,
      startedAt: maintenanceJobs.startedAt,
      status: maintenanceJobs.status,
      type: maintenanceJobs.type,
    })
    .from(maintenanceJobs)
    .where(eq(maintenanceJobs.id, jobId))
    .limit(1);

  if (!job) {
    return null;
  }

  // Retired job types (legacy_derivative_cleanup) can still exist as historical
  // rows. They have no progress shape we can report, so treat them as absent.
  if (job.type !== "library_hard_wipe") {
    return null;
  }

  return {
    completedAt: job.completedAt?.toISOString() ?? null,
    error: job.error,
    id: job.id,
    progress: job.progress as LibraryWipeJobProgress,
    startedAt: job.startedAt?.toISOString() ?? null,
    status: job.status,
    type: job.type,
  };
}

export async function resumePendingMaintenanceJobs(): Promise<void> {
  if (resumeStarted) {
    return;
  }

  resumeStarted = true;

  let jobs: { id: string }[];
  try {
    jobs = await db
      .select({ id: maintenanceJobs.id })
      .from(maintenanceJobs)
      .where(inArray(maintenanceJobs.status, [...activeJobStatuses]));
  } catch (error) {
    resumeStarted = false;
    throw error;
  }

  for (const job of jobs) {
    void processMaintenanceJob(job.id);
  }
}

export function processMaintenanceJob(jobId: string): void {
  if (runningJobs.has(jobId)) {
    return;
  }

  runningJobs.add(jobId);
  void runMaintenanceJobLoop(jobId).then(
    (continueInNextTurn) => {
      runningJobs.delete(jobId);
      if (continueInNextTurn) queueMicrotask(() => processMaintenanceJob(jobId));
    },
    async (error) => {
      runningJobs.delete(jobId);
      const message = error instanceof Error ? error.message : "Maintenance job failed";
      try {
        await db
          .update(maintenanceJobs)
          .set({ error: message, status: "failed" })
          .where(eq(maintenanceJobs.id, jobId));
      } catch (updateError) {
        console.error("[pane-view] Unable to record maintenance job failure", updateError);
      }
    },
  );
}

async function runMaintenanceJobLoop(jobId: string): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxBatchDurationMs) {
    const continued = await processMaintenanceJobBatch(jobId);
    if (!continued) {
      return false;
    }
  }

  return true;
}

async function processMaintenanceJobBatch(jobId: string): Promise<boolean> {
  const [job] = await db
    .select({
      progress: maintenanceJobs.progress,
      status: maintenanceJobs.status,
      type: maintenanceJobs.type,
    })
    .from(maintenanceJobs)
    .where(eq(maintenanceJobs.id, jobId))
    .limit(1);

  if (!job || job.status === "completed" || job.status === "failed") {
    return false;
  }

  if (job.status === "pending") {
    await db
      .update(maintenanceJobs)
      .set({
        startedAt: new Date(),
        status: "running",
      })
      .where(eq(maintenanceJobs.id, jobId));
  }

  const progress = job.progress;
  if ((progress as { phase?: string }).phase === "s3_derivatives") {
    await updateJobProgress(jobId, {
      errorCount: progress.errorCount,
      phase: "s3_originals",
      processedCount: progress.processedCount,
    });
    return true;
  }

  return processLibraryWipeBatch(jobId, progress as LibraryWipeJobProgress);
}

async function processLibraryWipeBatch(
  jobId: string,
  progress: LibraryWipeJobProgress,
): Promise<boolean> {
  const storage = createPaneViewStorageClient();

  switch (progress.phase) {
    case "s3_originals": {
      const rows = await db
        .select({
          id: mediaObjects.id,
          objectKey: mediaObjects.objectKey,
          sha256: mediaObjects.sha256,
        })
        .from(mediaObjects)
        .limit(batchSize);

      if (rows.length === 0) {
        await updateJobProgress(jobId, {
          ...progress,
          orphanPrefix: orphanPrefixes[0],
          phase: "s3_orphan_sweep",
        });
        return true;
      }

      const batch = await deleteStoredObjectsBatch({
        keys: rows.map((row) => row.objectKey),
        storage,
      });

      if (batch.errors > 0) {
        await updateJobProgress(jobId, {
          ...progress,
          errorCount: progress.errorCount + batch.errors,
          lastError: "One or more source objects could not be deleted; retrying batch",
        });
        return true;
      }

      for (const row of rows) {
        try {
          await purgeShutterSource(row.sha256);
        } catch (error) {
          await updateJobProgress(jobId, {
            ...progress,
            errorCount: progress.errorCount + 1,
            lastError: error instanceof Error ? error.message : "Shutter source purge failed",
          });
          return true;
        }
        await db.delete(mediaObjects).where(eq(mediaObjects.id, row.id));
      }

      await updateJobProgress(jobId, {
        ...progress,
        errorCount: progress.errorCount + batch.errors,
        processedCount: progress.processedCount + rows.length,
      });
      return true;
    }

    case "s3_orphan_sweep": {
      const prefix =
        progress.orphanPrefix ??
        orphanPrefixes[progress.processedCount % orphanPrefixes.length] ??
        orphanPrefixes[0];

      const page = await listStoredObjectsByPrefix({
        continuationToken: progress.orphanContinuationToken,
        limit: batchSize,
        prefix,
        storage,
      });

      if (page.keys.length > 0) {
        const batch = await deleteStoredObjectsBatch({
          keys: page.keys,
          storage,
        });

        await updateJobProgress(jobId, {
          ...progress,
          errorCount: progress.errorCount + batch.errors,
          orphanContinuationToken: page.nextContinuationToken,
          orphanPrefix: prefix,
          processedCount: progress.processedCount + page.keys.length,
        });
        return true;
      }

      if (page.nextContinuationToken) {
        await updateJobProgress(jobId, {
          ...progress,
          orphanContinuationToken: page.nextContinuationToken,
          orphanPrefix: prefix,
        });
        return true;
      }

      const prefixIndex = orphanPrefixes.indexOf(prefix as (typeof orphanPrefixes)[number]);
      const nextPrefix = orphanPrefixes[prefixIndex + 1];

      if (nextPrefix) {
        await updateJobProgress(jobId, {
          ...progress,
          orphanContinuationToken: undefined,
          orphanPrefix: nextPrefix,
        });
        return true;
      }

      await updateJobProgress(jobId, {
        ...progress,
        orphanContinuationToken: undefined,
        orphanPrefix: undefined,
        phase: "db_hard_delete",
      });
      return true;
    }

    case "db_hard_delete": {
      await db.delete(favorites).where(eq(favorites.subjectType, "library_entry"));
      await db.delete(viewerState).where(eq(viewerState.subjectType, "library_entry"));
      await db.delete(syncRunItems);
      await db.delete(syncRuns);
      await db.delete(libraryEntries);
      await db.delete(folders);
      await db.delete(mediaObjects);

      await db
        .update(maintenanceJobs)
        .set({
          completedAt: new Date(),
          progress: {
            ...progress,
            phase: "completed",
          },
          status: "completed",
        })
        .where(eq(maintenanceJobs.id, jobId));
      return false;
    }

    case "completed":
      return false;
  }
}

async function updateJobProgress(jobId: string, progress: MaintenanceJobProgress): Promise<void> {
  await db.update(maintenanceJobs).set({ progress }).where(eq(maintenanceJobs.id, jobId));
}
