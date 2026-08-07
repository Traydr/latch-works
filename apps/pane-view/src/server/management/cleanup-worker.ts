import { listStoredObjectsByPrefix } from "@latch-works/media-storage";
import { and, eq, exists, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { db } from "../db";
import {
  favorites,
  folders,
  type LibraryWipeJobProgress,
  libraryEntries,
  type MaintenanceJobProgress,
  maintenanceJobs,
  mediaObjects,
  type SoftDeletedPurgeJobProgress,
  syncRunItems,
  syncRuns,
  viewerState,
} from "../db/schema";
import { purgeShutterSource } from "../media/shutter-client";
import { deleteMaintenanceObjects, getMaintenanceStorageClient } from "./maintenance-storage";

const batchSize = 25;
const nextBatchDelayMs = 25;

const orphanPrefixes = ["originals/"] as const;

const activeJobStatuses = ["pending", "running"] as const;

let resumeStarted = false;
const runningJobs = new Set<string>();

interface CleanupJobStatusBase {
  completedAt: string | null;
  error: string | null;
  id: string;
  startedAt: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
}

export type CleanupJobStatus = CleanupJobStatusBase &
  (
    | { progress: LibraryWipeJobProgress; type: "library_hard_wipe" }
    | { progress: SoftDeletedPurgeJobProgress; type: "soft_deleted_purge" }
  );

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
  if (job.type !== "library_hard_wipe" && job.type !== "soft_deleted_purge") {
    return null;
  }

  const base = {
    completedAt: job.completedAt?.toISOString() ?? null,
    error: job.error,
    id: job.id,
    startedAt: job.startedAt?.toISOString() ?? null,
    status: job.status,
  };

  return job.type === "library_hard_wipe"
    ? { ...base, progress: job.progress as LibraryWipeJobProgress, type: job.type }
    : { ...base, progress: job.progress as SoftDeletedPurgeJobProgress, type: job.type };
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
  void processMaintenanceJobBatch(jobId).then(
    (continueInNextTurn) => {
      runningJobs.delete(jobId);
      if (continueInNextTurn) {
        setTimeout(() => processMaintenanceJob(jobId), nextBatchDelayMs);
      }
    },
    async (error) => {
      runningJobs.delete(jobId);
      const message = error instanceof Error ? error.message : "Maintenance job failed";
      try {
        await db
          .update(maintenanceJobs)
          .set({ completedAt: new Date(), error: message, status: "failed" })
          .where(
            and(
              eq(maintenanceJobs.id, jobId),
              inArray(maintenanceJobs.status, [...activeJobStatuses]),
            ),
          );
      } catch (updateError) {
        console.error("[pane-view] Unable to record maintenance job failure", updateError);
      }
    },
  );
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

  if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return false;
  }

  if (job.status === "pending") {
    await db
      .update(maintenanceJobs)
      .set({
        startedAt: new Date(),
        status: "running",
      })
      .where(and(eq(maintenanceJobs.id, jobId), eq(maintenanceJobs.status, "pending")));
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

  if (job.type === "library_hard_wipe") {
    return processLibraryWipeBatch(jobId, progress as LibraryWipeJobProgress);
  }

  if (job.type === "soft_deleted_purge") {
    return processSoftDeletedPurgeBatch(jobId, progress as SoftDeletedPurgeJobProgress);
  }

  return false;
}

async function processSoftDeletedPurgeBatch(
  jobId: string,
  progress: SoftDeletedPurgeJobProgress,
): Promise<boolean> {
  switch (progress.phase) {
    case "orphaned_media": {
      const deletedReference = db
        .select({ value: sql`1` })
        .from(libraryEntries)
        .where(
          and(
            eq(libraryEntries.mediaObjectId, mediaObjects.id),
            isNotNull(libraryEntries.deletedAt),
          ),
        );
      const activeReference = db
        .select({ value: sql`1` })
        .from(libraryEntries)
        .where(
          and(eq(libraryEntries.mediaObjectId, mediaObjects.id), isNull(libraryEntries.deletedAt)),
        );
      const rows = await db
        .select({
          id: mediaObjects.id,
          objectKey: mediaObjects.objectKey,
          sha256: mediaObjects.sha256,
        })
        .from(mediaObjects)
        .where(and(exists(deletedReference), notExists(activeReference)))
        .limit(batchSize);

      if (rows.length === 0) {
        await updateJobProgress(jobId, { ...progress, phase: "db_hard_delete" });
        return true;
      }

      await deleteMaintenanceObjects(rows.map((row) => row.objectKey));
      if (!(await isMaintenanceJobActive(jobId))) return false;

      for (const row of rows) {
        try {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Keep each external purge and database delete retry-safe.
          await purgeShutterSource(row.sha256);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Shutter source purge failed: ${reason}`);
        }
        const entryIds = db
          .select({ id: libraryEntries.id })
          .from(libraryEntries)
          .where(eq(libraryEntries.mediaObjectId, row.id));
        // Deleting an unshared media row cascades its soft-deleted library entries. Generic
        // subject state has no foreign key, so remove it explicitly in the same transaction.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each transaction advances the durable cleanup cursor.
        await db.transaction(async (tx) => {
          await tx
            .delete(favorites)
            .where(
              and(
                eq(favorites.subjectType, "library_entry"),
                inArray(favorites.subjectId, entryIds),
              ),
            );
          await tx
            .delete(viewerState)
            .where(
              and(
                eq(viewerState.subjectType, "library_entry"),
                inArray(viewerState.subjectId, entryIds),
              ),
            );
          await tx.delete(mediaObjects).where(eq(mediaObjects.id, row.id));
        });
      }

      await updateJobProgress(jobId, {
        ...progress,
        lastError: undefined,
        processedCount: progress.processedCount + rows.length,
      });
      return true;
    }

    case "db_hard_delete": {
      const deletedEntryIds = db
        .select({ id: libraryEntries.id })
        .from(libraryEntries)
        .where(isNotNull(libraryEntries.deletedAt));

      await db.transaction(async (tx) => {
        await tx
          .delete(favorites)
          .where(
            and(
              eq(favorites.subjectType, "library_entry"),
              inArray(favorites.subjectId, deletedEntryIds),
            ),
          );
        await tx
          .delete(viewerState)
          .where(
            and(
              eq(viewerState.subjectType, "library_entry"),
              inArray(viewerState.subjectId, deletedEntryIds),
            ),
          );
        await tx.delete(libraryEntries).where(isNotNull(libraryEntries.deletedAt));
      });

      await db
        .update(maintenanceJobs)
        .set({
          completedAt: new Date(),
          progress: { ...progress, phase: "completed" },
          status: "completed",
        })
        .where(
          and(
            eq(maintenanceJobs.id, jobId),
            inArray(maintenanceJobs.status, [...activeJobStatuses]),
          ),
        );
      return false;
    }

    case "completed":
      return false;
  }
}

async function processLibraryWipeBatch(
  jobId: string,
  progress: LibraryWipeJobProgress,
): Promise<boolean> {
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

      await deleteMaintenanceObjects(rows.map((row) => row.objectKey));
      if (!(await isMaintenanceJobActive(jobId))) return false;

      for (const row of rows) {
        try {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Stop at the first purge failure so the durable job cursor remains retry-safe.
          await purgeShutterSource(row.sha256);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Shutter source purge failed: ${reason}`);
        }
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Delete only after this row's external source purge succeeds.
        await db.delete(mediaObjects).where(eq(mediaObjects.id, row.id));
      }

      await updateJobProgress(jobId, {
        ...progress,
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
        storage: getMaintenanceStorageClient(),
      });

      if (page.keys.length > 0) {
        await deleteMaintenanceObjects(page.keys);
        if (!(await isMaintenanceJobActive(jobId))) return false;

        await updateJobProgress(jobId, {
          ...progress,
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
        .where(
          and(
            eq(maintenanceJobs.id, jobId),
            inArray(maintenanceJobs.status, [...activeJobStatuses]),
          ),
        );
      return false;
    }

    case "completed":
      return false;
  }
}

async function updateJobProgress(jobId: string, progress: MaintenanceJobProgress): Promise<void> {
  await db
    .update(maintenanceJobs)
    .set({ progress })
    .where(
      and(eq(maintenanceJobs.id, jobId), inArray(maintenanceJobs.status, [...activeJobStatuses])),
    );
}

async function isMaintenanceJobActive(jobId: string): Promise<boolean> {
  const [job] = await db
    .select({ id: maintenanceJobs.id })
    .from(maintenanceJobs)
    .where(
      and(eq(maintenanceJobs.id, jobId), inArray(maintenanceJobs.status, [...activeJobStatuses])),
    )
    .limit(1);

  return Boolean(job);
}
