import { type ListStoredObjectsPage, listStoredObjectsByPrefix } from "@latch-works/media-storage";
import { and, eq, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { type Database, db } from "../db";
import {
  favorites,
  folders,
  type LibraryWipeJobProgress,
  libraryEntries,
  type MaintenanceJobProgress,
  maintenanceJobs,
  mediaObjects,
  type ShutterSourcePurgeJobProgress,
  type SoftDeletedPurgeJobProgress,
  shutterSourceCleanup,
  syncRunItems,
  syncRuns,
  viewerState,
} from "../db/schema";
import { purgeShutterSource } from "../media/shutter-client";
import { MaintenanceJobTypeSchema, parseMaintenanceProgress } from "./maintenance-progress";
import { deleteMaintenanceObjects, getMaintenanceStorageClient } from "./maintenance-storage";
import { orphanedMediaObjectCondition, orphanedShutterSourceCondition } from "./orphaned-sources";

const batchSize = 25;
const nextBatchDelayMs = 25;

const orphanPrefixes = ["originals/"] as const;

const activeJobStatuses = ["pending", "running"] as const;

let resumeStarted = false;
const runningJobs = new Set<string>();

/**
 * Everything a maintenance batch reaches outside its own module: the archive
 * database, the object storage deletes and listing, and the Shutter purge.
 * The default instance wires the real ones; a suite passes a pglite database
 * and fakes for the two external services.
 */
export interface MaintenanceWorkerDependencies {
  database: Database;
  deleteObjects(keys: string[]): Promise<{ deleted: number }>;
  listObjectsByPrefix(request: {
    continuationToken?: string;
    limit: number;
    prefix: string;
  }): Promise<ListStoredObjectsPage>;
  purgeShutterSource(sha256: string): Promise<void>;
}

const defaultMaintenanceWorkerDependencies: MaintenanceWorkerDependencies = {
  database: db,
  deleteObjects: deleteMaintenanceObjects,
  listObjectsByPrefix: (request) =>
    listStoredObjectsByPrefix({ ...request, storage: getMaintenanceStorageClient() }),
  purgeShutterSource,
};

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
    | { progress: ShutterSourcePurgeJobProgress; type: "shutter_source_purge" }
  );

export async function readCleanupJobStatus(
  { jobId }: { jobId: string },
  dependencies: MaintenanceWorkerDependencies = defaultMaintenanceWorkerDependencies,
): Promise<CleanupJobStatus | null> {
  const [job] = await dependencies.database
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
  // rows. They have no progress contract we can report, so treat them as
  // absent; the same goes for a row whose progress does not parse for its type.
  const type = MaintenanceJobTypeSchema.safeParse(job.type);
  if (!type.success) {
    return null;
  }

  const base = {
    completedAt: job.completedAt?.toISOString() ?? null,
    error: job.error,
    id: job.id,
    startedAt: job.startedAt?.toISOString() ?? null,
    status: job.status,
  };

  switch (type.data) {
    case "library_hard_wipe": {
      const parsed = parseMaintenanceProgress(type.data, job.progress);
      return parsed.ok ? { ...base, progress: parsed.progress, type: type.data } : null;
    }
    case "soft_deleted_purge": {
      const parsed = parseMaintenanceProgress(type.data, job.progress);
      return parsed.ok ? { ...base, progress: parsed.progress, type: type.data } : null;
    }
    case "shutter_source_purge": {
      const parsed = parseMaintenanceProgress(type.data, job.progress);
      return parsed.ok ? { ...base, progress: parsed.progress, type: type.data } : null;
    }
  }
}

export async function resumePendingMaintenanceJobs(
  dependencies: MaintenanceWorkerDependencies = defaultMaintenanceWorkerDependencies,
): Promise<void> {
  if (resumeStarted) {
    return;
  }

  resumeStarted = true;

  let jobs: { id: string }[];
  try {
    jobs = await dependencies.database
      .select({ id: maintenanceJobs.id })
      .from(maintenanceJobs)
      .where(inArray(maintenanceJobs.status, [...activeJobStatuses]));
  } catch (error) {
    resumeStarted = false;
    throw error;
  }

  for (const job of jobs) {
    void processMaintenanceJob(job.id, dependencies);
  }
}

export function processMaintenanceJob(
  jobId: string,
  dependencies: MaintenanceWorkerDependencies = defaultMaintenanceWorkerDependencies,
): void {
  if (runningJobs.has(jobId)) {
    return;
  }

  runningJobs.add(jobId);
  void processMaintenanceJobBatch(jobId, dependencies).then(
    (continueInNextTurn) => {
      runningJobs.delete(jobId);
      if (continueInNextTurn) {
        setTimeout(() => processMaintenanceJob(jobId, dependencies), nextBatchDelayMs);
      }
    },
    async (error) => {
      runningJobs.delete(jobId);
      const message = error instanceof Error ? error.message : "Maintenance job failed";
      try {
        await failMaintenanceJob(jobId, message, dependencies);
      } catch (updateError) {
        console.error("[pane-view] Unable to record maintenance job failure", updateError);
      }
    },
  );
}

/**
 * Run one batch of `jobId`. Resolves true when another batch should follow.
 * Exported as an internal seam for cleanup-worker.test.ts; production drives
 * it through processMaintenanceJob.
 */
export async function processMaintenanceJobBatch(
  jobId: string,
  dependencies: MaintenanceWorkerDependencies = defaultMaintenanceWorkerDependencies,
): Promise<boolean> {
  const [job] = await dependencies.database
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
    await dependencies.database
      .update(maintenanceJobs)
      .set({
        startedAt: new Date(),
        status: "running",
      })
      .where(and(eq(maintenanceJobs.id, jobId), eq(maintenanceJobs.status, "pending")));
  }

  const type = MaintenanceJobTypeSchema.safeParse(job.type);
  if (!type.success) {
    return false;
  }

  // Progress is jsonb; the parser is the only way it reaches a batch. A phase
  // that is not valid for this job's type fails the job instead of advancing
  // it (the cross-type phase leak the old inline s3_derivatives rewrite had).
  switch (type.data) {
    case "library_hard_wipe": {
      const parsed = parseMaintenanceProgress(type.data, job.progress);
      if (!parsed.ok) return failUnrecognisedProgress(jobId, parsed.reason, dependencies);
      return processLibraryWipeBatch(jobId, parsed.progress, dependencies);
    }
    case "soft_deleted_purge": {
      const parsed = parseMaintenanceProgress(type.data, job.progress);
      if (!parsed.ok) return failUnrecognisedProgress(jobId, parsed.reason, dependencies);
      return processSoftDeletedPurgeBatch(jobId, parsed.progress, dependencies);
    }
    case "shutter_source_purge": {
      const parsed = parseMaintenanceProgress(type.data, job.progress);
      if (!parsed.ok) return failUnrecognisedProgress(jobId, parsed.reason, dependencies);
      return processShutterSourcePurgeBatch(jobId, parsed.progress, dependencies);
    }
  }
}

async function failUnrecognisedProgress(
  jobId: string,
  reason: string,
  dependencies: MaintenanceWorkerDependencies,
): Promise<false> {
  await failMaintenanceJob(jobId, `Unrecognised job progress: ${reason}`, dependencies);
  return false;
}

async function processSoftDeletedPurgeBatch(
  jobId: string,
  progress: SoftDeletedPurgeJobProgress,
  dependencies: MaintenanceWorkerDependencies,
): Promise<boolean> {
  switch (progress.phase) {
    case "orphaned_media": {
      const rows = await dependencies.database
        .select({
          id: mediaObjects.id,
          objectKey: mediaObjects.objectKey,
          sha256: mediaObjects.sha256,
        })
        .from(mediaObjects)
        .where(orphanedMediaObjectCondition())
        .limit(batchSize);

      if (rows.length === 0) {
        await updateJobProgress(jobId, { ...progress, phase: "db_hard_delete" }, dependencies);
        return true;
      }

      await dependencies.deleteObjects(rows.map((row) => row.objectKey));
      if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;

      for (const row of rows) {
        const entryIds = dependencies.database
          .select({ id: libraryEntries.id })
          .from(libraryEntries)
          .where(eq(libraryEntries.mediaObjectId, row.id));
        // Deleting an unshared media row cascades its soft-deleted library entries. Generic
        // subject state has no foreign key, so remove it explicitly in the same transaction.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each transaction advances the durable cleanup cursor.
        await dependencies.database.transaction(async (tx) => {
          await tx
            .insert(shutterSourceCleanup)
            .values({ sha256: row.sha256 })
            .onConflictDoNothing();
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

      await updateJobProgress(
        jobId,
        {
          ...progress,
          processedCount: progress.processedCount + rows.length,
        },
        dependencies,
      );
      return true;
    }

    case "db_hard_delete": {
      const deletedEntryIds = dependencies.database
        .select({ id: libraryEntries.id })
        .from(libraryEntries)
        .where(isNotNull(libraryEntries.deletedAt));

      await dependencies.database.transaction(async (tx) => {
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

      await completeMaintenanceJob(jobId, { ...progress, phase: "completed" }, dependencies);
      return false;
    }

    case "completed":
      return false;
  }
}

async function processShutterSourcePurgeBatch(
  jobId: string,
  progress: ShutterSourcePurgeJobProgress,
  dependencies: MaintenanceWorkerDependencies,
): Promise<boolean> {
  switch (progress.phase) {
    case "queue_sources": {
      const rows = await dependencies.database
        .select({ sha256: mediaObjects.sha256 })
        .from(mediaObjects)
        .where(orphanedShutterSourceCondition())
        .limit(batchSize);

      if (rows.length === 0) {
        await updateJobProgress(jobId, { ...progress, phase: "shutter_sources" }, dependencies);
        return true;
      }

      await dependencies.database.insert(shutterSourceCleanup).values(rows).onConflictDoNothing();
      return true;
    }

    case "shutter_sources": {
      const activeSourceReference = dependencies.database
        .select({ value: sql`1` })
        .from(libraryEntries)
        .innerJoin(mediaObjects, eq(mediaObjects.id, libraryEntries.mediaObjectId))
        .where(
          and(
            eq(mediaObjects.sha256, shutterSourceCleanup.sha256),
            isNull(libraryEntries.deletedAt),
          ),
        );
      const rows = await dependencies.database
        .select({ sha256: shutterSourceCleanup.sha256 })
        .from(shutterSourceCleanup)
        .where(and(isNull(shutterSourceCleanup.purgedAt), notExists(activeSourceReference)))
        .limit(batchSize);

      if (rows.length === 0) {
        await completeMaintenanceJob(jobId, { ...progress, phase: "completed" }, dependencies);
        return false;
      }

      for (const row of rows) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Mark each source only after Shutter confirms its purge.
        await dependencies.purgeShutterSource(row.sha256);
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- The durable queue advances one confirmed source at a time.
        await dependencies.database
          .update(shutterSourceCleanup)
          .set({ purgedAt: new Date() })
          .where(eq(shutterSourceCleanup.sha256, row.sha256));
        if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;
      }

      await updateJobProgress(
        jobId,
        {
          ...progress,
          processedCount: progress.processedCount + rows.length,
        },
        dependencies,
      );
      return true;
    }

    case "completed":
      return false;
  }
}

async function processLibraryWipeBatch(
  jobId: string,
  progress: LibraryWipeJobProgress,
  dependencies: MaintenanceWorkerDependencies,
): Promise<boolean> {
  switch (progress.phase) {
    case "s3_originals": {
      const rows = await dependencies.database
        .select({
          id: mediaObjects.id,
          objectKey: mediaObjects.objectKey,
          sha256: mediaObjects.sha256,
        })
        .from(mediaObjects)
        .limit(batchSize);

      if (rows.length === 0) {
        await updateJobProgress(
          jobId,
          {
            ...progress,
            orphanPrefix: orphanPrefixes[0],
            phase: "s3_orphan_sweep",
          },
          dependencies,
        );
        return true;
      }

      await dependencies.deleteObjects(rows.map((row) => row.objectKey));
      if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;

      for (const row of rows) {
        try {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Stop at the first purge failure so the durable job cursor remains retry-safe.
          await dependencies.purgeShutterSource(row.sha256);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Shutter source purge failed: ${reason}`);
        }
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Delete only after this row's external source purge succeeds.
        await dependencies.database.delete(mediaObjects).where(eq(mediaObjects.id, row.id));
      }

      await updateJobProgress(
        jobId,
        {
          ...progress,
          processedCount: progress.processedCount + rows.length,
        },
        dependencies,
      );
      return true;
    }

    case "s3_orphan_sweep": {
      const prefix =
        progress.orphanPrefix ??
        orphanPrefixes[progress.processedCount % orphanPrefixes.length] ??
        orphanPrefixes[0];

      const page = await dependencies.listObjectsByPrefix({
        continuationToken: progress.orphanContinuationToken ?? undefined,
        limit: batchSize,
        prefix,
      });

      if (page.keys.length > 0) {
        await dependencies.deleteObjects(page.keys);
        if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;

        await updateJobProgress(
          jobId,
          {
            ...progress,
            orphanContinuationToken: page.nextContinuationToken ?? null,
            orphanPrefix: prefix,
            processedCount: progress.processedCount + page.keys.length,
          },
          dependencies,
        );
        return true;
      }

      if (page.nextContinuationToken) {
        await updateJobProgress(
          jobId,
          {
            ...progress,
            orphanContinuationToken: page.nextContinuationToken,
            orphanPrefix: prefix,
          },
          dependencies,
        );
        return true;
      }

      // The stored prefix is a plain string; a prefix no longer in the list has no successor.
      const knownPrefixes: readonly string[] = orphanPrefixes;
      const prefixIndex = knownPrefixes.indexOf(prefix);
      const nextPrefix = prefixIndex >= 0 ? orphanPrefixes[prefixIndex + 1] : undefined;

      if (nextPrefix) {
        await updateJobProgress(
          jobId,
          {
            ...progress,
            orphanContinuationToken: null,
            orphanPrefix: nextPrefix,
          },
          dependencies,
        );
        return true;
      }

      await updateJobProgress(
        jobId,
        {
          ...progress,
          orphanContinuationToken: null,
          orphanPrefix: null,
          phase: "db_hard_delete",
        },
        dependencies,
      );
      return true;
    }

    case "db_hard_delete": {
      await dependencies.database
        .delete(favorites)
        .where(eq(favorites.subjectType, "library_entry"));
      await dependencies.database
        .delete(viewerState)
        .where(eq(viewerState.subjectType, "library_entry"));
      await dependencies.database.delete(syncRunItems);
      await dependencies.database.delete(syncRuns);
      await dependencies.database.delete(libraryEntries);
      await dependencies.database.delete(folders);
      await dependencies.database.delete(mediaObjects);

      await completeMaintenanceJob(jobId, { ...progress, phase: "completed" }, dependencies);
      return false;
    }

    case "completed":
      return false;
  }
}

/** Mark an active job completed with its final progress; a no-op once it is no longer active. */
async function completeMaintenanceJob(
  jobId: string,
  progress: MaintenanceJobProgress,
  dependencies: MaintenanceWorkerDependencies,
): Promise<void> {
  await dependencies.database
    .update(maintenanceJobs)
    .set({ completedAt: new Date(), progress, status: "completed" })
    .where(
      and(eq(maintenanceJobs.id, jobId), inArray(maintenanceJobs.status, [...activeJobStatuses])),
    );
}

/** Mark an active job failed with `message`; a no-op once it is no longer active. */
async function failMaintenanceJob(
  jobId: string,
  message: string,
  dependencies: MaintenanceWorkerDependencies,
): Promise<void> {
  await dependencies.database
    .update(maintenanceJobs)
    .set({ completedAt: new Date(), error: message, status: "failed" })
    .where(
      and(eq(maintenanceJobs.id, jobId), inArray(maintenanceJobs.status, [...activeJobStatuses])),
    );
}

async function updateJobProgress(
  jobId: string,
  progress: MaintenanceJobProgress,
  dependencies: MaintenanceWorkerDependencies,
): Promise<void> {
  await dependencies.database
    .update(maintenanceJobs)
    .set({ progress })
    .where(
      and(eq(maintenanceJobs.id, jobId), inArray(maintenanceJobs.status, [...activeJobStatuses])),
    );
}

async function isMaintenanceJobActive(
  jobId: string,
  dependencies: MaintenanceWorkerDependencies,
): Promise<boolean> {
  const [job] = await dependencies.database
    .select({ id: maintenanceJobs.id })
    .from(maintenanceJobs)
    .where(
      and(eq(maintenanceJobs.id, jobId), inArray(maintenanceJobs.status, [...activeJobStatuses])),
    )
    .limit(1);

  return Boolean(job);
}
