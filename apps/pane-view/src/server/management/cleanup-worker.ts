import { type ListStoredObjectsPage, listStoredObjectsByPrefix } from "@latch-works/media-storage";
import { and, eq, inArray, isNotNull, isNull, not, sql } from "drizzle-orm";
import type { JsonValue } from "@/lib/json";
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
import { withAncestorPaths } from "../library/folder-path-sql";
import {
  purgeShutterSource,
  SHUTTER_PURGE_INCOMPLETE_MESSAGE,
  type ShutterPurgeReadiness,
  type ShutterPurgeSource,
  shutterPurgeReadiness,
} from "../media/shutter-client";
import {
  type MaintenanceJobType,
  MaintenanceJobTypeSchema,
  type MaintenanceProgressFor,
  ORPHAN_SWEEP_PREFIX,
  parseMaintenanceProgress,
} from "./maintenance-progress";
import { deleteMaintenanceObjects, getMaintenanceStorageClient } from "./maintenance-storage";
import {
  liveShutterSourceCondition,
  orphanedMediaObjectCondition,
  orphanedShutterSourceCondition,
} from "./orphaned-sources";

const batchSize = 25;

const nextBatchDelayMs = 25;

/** How long to wait before retrying a job whose claim another worker holds. */
const contendedRetryDelayMs = 30_000;

const activeJobStatuses = ["pending", "running"] as const;

/** Advisory lock namespace ("LWMJ") for per-job batch claims; the job id hash is the key. */
const MAINTENANCE_JOB_CLAIM_LOCK_NAMESPACE = 0x4c57_4d4a;

let resumeStarted = false;

const runningJobs = new Set<string>();

/**
 * Everything a maintenance batch reaches outside its own module: the archive
 * database, the object storage deletes and listing, and the Shutter purge.
 * The default instance wires the real ones; a suite passes a pglite database
 * and fakes for the two external services.
 */
export interface MaintenanceWorkerDependencies {
  /**
   * Run `batch` while holding the job's claim, or resolve "contended" without
   * running it when another worker holds the claim.
   */
  claimJobBatch(jobId: string, batch: () => Promise<boolean>): Promise<boolean | "contended">;
  database: Database;
  deleteObjects(keys: string[]): Promise<{ deleted: number }>;
  /** Whether this deployment can purge Shutter's copies (see shutterPurgeReadiness). */
  shutterPurgeReadiness(): ShutterPurgeReadiness;
  listObjectsByPrefix(request: {
    continuationToken?: string;
    limit: number;
    prefix: string;
  }): Promise<ListStoredObjectsPage>;
  purgeShutterSource(source: ShutterPurgeSource): Promise<void>;
}

const defaultMaintenanceWorkerDependencies: MaintenanceWorkerDependencies = {
  claimJobBatch: (jobId, batch) => claimMaintenanceJobBatch(db, jobId, batch),
  database: db,
  deleteObjects: deleteMaintenanceObjects,
  listObjectsByPrefix: (request) =>
    listStoredObjectsByPrefix({ ...request, storage: getMaintenanceStorageClient() }),
  purgeShutterSource,
  shutterPurgeReadiness: () => shutterPurgeReadiness(),
};

interface CleanupJobStatusBase {
  completedAt: string | null;
  error: string | null;
  id: string;
  startedAt: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
}

type CleanupJobStatusByType = {
  [Type in MaintenanceJobType]: CleanupJobStatusBase & {
    progress: MaintenanceProgressFor<Type>;
    type: Type;
  };
};

export type CleanupJobStatus = CleanupJobStatusByType[MaintenanceJobType];

/**
 * What each job type does with its parsed progress: `run` advances one batch,
 * `toStatus` reports it. Both lookups go through a generic `Type`, so a type's
 * entry only ever sees progress that parsed for that type.
 */
type MaintenanceJobHandlers = {
  [Type in MaintenanceJobType]: {
    run(
      jobId: string,
      progress: MaintenanceProgressFor<Type>,
      dependencies: MaintenanceWorkerDependencies,
    ): Promise<boolean>;
    toStatus(
      base: CleanupJobStatusBase,
      progress: MaintenanceProgressFor<Type>,
      type: Type,
    ): CleanupJobStatusByType[Type];
  };
};

function toCleanupJobStatus<Type extends MaintenanceJobType>(
  base: CleanupJobStatusBase,
  progress: MaintenanceProgressFor<Type>,
  type: Type,
): CleanupJobStatusBase & { progress: MaintenanceProgressFor<Type>; type: Type } {
  return { ...base, progress, type };
}

const maintenanceJobHandlers: MaintenanceJobHandlers = {
  library_hard_wipe: { run: processLibraryWipeBatch, toStatus: toCleanupJobStatus },
  shutter_source_purge: { run: processShutterSourcePurgeBatch, toStatus: toCleanupJobStatus },
  soft_deleted_purge: { run: processSoftDeletedPurgeBatch, toStatus: toCleanupJobStatus },
};

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

  return cleanupJobStatusFor(type.data, job.progress, {
    completedAt: job.completedAt?.toISOString() ?? null,
    error: job.error,
    id: job.id,
    startedAt: job.startedAt?.toISOString() ?? null,
    status: job.status,
  });
}

function cleanupJobStatusFor<Type extends MaintenanceJobType>(
  type: Type,
  rawProgress: JsonValue,
  base: CleanupJobStatusBase,
): CleanupJobStatusByType[Type] | null {
  const parsed = parseMaintenanceProgress(type, rawProgress);

  return parsed.ok ? maintenanceJobHandlers[type].toStatus(base, parsed.progress, type) : null;
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
  void dependencies
    .claimJobBatch(jobId, () => processMaintenanceJobBatch(jobId, dependencies))
    .then(
      (outcome) => {
        runningJobs.delete(jobId);

        // Another worker holds the claim. Keep trying, so the job is taken
        // back if that worker dies with it unfinished.
        if (outcome === "contended") {
          setTimeout(() => processMaintenanceJob(jobId, dependencies), contendedRetryDelayMs);
        } else if (outcome) {
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
 * Run one batch under the job's claim: a transaction-scoped advisory lock
 * keyed by the job id, taken on a connection of its own while the batch runs
 * through the pool as before. The in-memory set only keeps this process from
 * running a job twice; the claim also keeps a second process from running a
 * batch alongside it. Without the claim this resolves "contended".
 */
async function claimMaintenanceJobBatch(
  database: Database,
  jobId: string,
  batch: () => Promise<boolean>,
): Promise<boolean | "contended"> {
  return database.transaction(async (claim) => {
    const [row] = await claim
      .select({
        claimed: sql<boolean>`pg_try_advisory_xact_lock(${MAINTENANCE_JOB_CLAIM_LOCK_NAMESPACE}, hashtext(${jobId}))`,
      })
      .from(maintenanceJobs)
      .where(eq(maintenanceJobs.id, jobId));

    if (row?.claimed !== true) return "contended";

    return batch();
  });
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

  return runJobBatch(type.data, jobId, job.progress, dependencies);
}

/**
 * Progress is jsonb; the parser is the only way it reaches a batch. A phase
 * that is not valid for this job's type fails the job instead of advancing it
 * (the cross-type phase leak the old inline s3_derivatives rewrite had).
 */
async function runJobBatch<Type extends MaintenanceJobType>(
  type: Type,
  jobId: string,
  rawProgress: JsonValue,
  dependencies: MaintenanceWorkerDependencies,
): Promise<boolean> {
  const parsed = parseMaintenanceProgress(type, rawProgress);

  if (!parsed.ok) return failUnrecognisedProgress(jobId, parsed.reason, dependencies);

  return maintenanceJobHandlers[type].run(jobId, parsed.progress, dependencies);
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

      if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;

      await dependencies.deleteObjects(rows.map((row) => row.objectKey));

      for (const row of rows) {
        const entryIds = dependencies.database
          .select({ id: libraryEntries.id })
          .from(libraryEntries)
          .where(eq(libraryEntries.mediaObjectId, row.id));

        // Deleting an unshared media row cascades its soft-deleted library entries. Generic
        // subject state has no foreign key, so remove it explicitly in the same transaction.
        // A cancel stops the batch before its next media row.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each transaction advances the durable cleanup cursor.
        const active = await dependencies.database.transaction(async (tx) => {
          if (!(await lockActiveMaintenanceJob(tx, jobId))) return false;

          await tx
            .insert(shutterSourceCleanup)
            .values({ objectKey: row.objectKey, sha256: row.sha256 })
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

          return true;
        });

        if (!active) return false;
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

      const active = await dependencies.database.transaction(async (tx) => {
        if (!(await lockActiveMaintenanceJob(tx, jobId))) return false;

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

        // A folder row cascades to its child folders, so a deleted folder that
        // still holds anything live (a re-synced file, a live subfolder) stays.
        const liveEntryFolders = tx
          .select({ path: libraryEntries.parentPath })
          .from(libraryEntries)
          .where(isNull(libraryEntries.deletedAt));

        const liveFolders = tx
          .select({ path: folders.path })
          .from(folders)
          .where(isNull(folders.deletedAt));

        const occupiedPaths = withAncestorPaths(sql`${liveEntryFolders} union ${liveFolders}`);

        await tx
          .delete(folders)
          .where(and(isNotNull(folders.deletedAt), sql`${folders.path} not in (${occupiedPaths})`));

        return true;
      });

      if (!active) return false;

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
        .select({ objectKey: mediaObjects.objectKey, sha256: mediaObjects.sha256 })
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
      // Sync drops a source's row when its content goes live again; rows from
      // before it did, pending or purged, are dropped here instead of lingering.
      await dependencies.database.delete(shutterSourceCleanup).where(liveShutterSourceCondition());

      const rows = await dependencies.database
        .select({ objectKey: shutterSourceCleanup.objectKey, sha256: shutterSourceCleanup.sha256 })
        .from(shutterSourceCleanup)
        .where(and(isNull(shutterSourceCleanup.purgedAt), not(liveShutterSourceCondition())))
        .limit(batchSize);

      if (rows.length === 0) {
        await completeMaintenanceJob(jobId, { ...progress, phase: "completed" }, dependencies);

        return false;
      }

      for (const row of rows) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- A cancel stops the batch before its next purge.
        if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;

        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Mark each source only after Shutter confirms its purge.
        await dependencies.purgeShutterSource(row);
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- The durable queue advances one confirmed source at a time.
        await dependencies.database
          .update(shutterSourceCleanup)
          .set({ purgedAt: new Date() })
          .where(eq(shutterSourceCleanup.sha256, row.sha256));
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
        await updateJobProgress(jobId, { ...progress, phase: "s3_orphan_sweep" }, dependencies);

        return true;
      }

      // Without Shutter there is nothing to purge. Partly configured, the purge
      // cannot run, so stop before the originals and the rows naming them go.
      const shutterPurge = dependencies.shutterPurgeReadiness();

      if (shutterPurge === "incomplete") throw new Error(SHUTTER_PURGE_INCOMPLETE_MESSAGE);

      if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;

      await dependencies.deleteObjects(rows.map((row) => row.objectKey));

      for (const row of rows) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- A cancel stops the batch before its next purge and delete.
        if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;

        try {
          if (shutterPurge === "ready") {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Stop at the first purge failure so the durable job cursor remains retry-safe.
            await dependencies.purgeShutterSource({ objectKey: row.objectKey, sha256: row.sha256 });
          }
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
      const page = await dependencies.listObjectsByPrefix({
        continuationToken: progress.orphanContinuationToken ?? undefined,
        limit: batchSize,
        prefix: ORPHAN_SWEEP_PREFIX,
      });

      if (page.keys.length > 0) {
        if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;

        await dependencies.deleteObjects(page.keys);

        if (!(await isMaintenanceJobActive(jobId, dependencies))) return false;

        await updateJobProgress(
          jobId,
          {
            ...progress,
            orphanContinuationToken: page.nextContinuationToken ?? null,
            processedCount: progress.processedCount + page.keys.length,
          },
          dependencies,
        );

        return true;
      }

      await updateJobProgress(
        jobId,
        page.nextContinuationToken
          ? { ...progress, orphanContinuationToken: page.nextContinuationToken }
          : { ...progress, orphanContinuationToken: null, phase: "db_hard_delete" },
        dependencies,
      );

      return true;
    }

    case "db_hard_delete": {
      const active = await dependencies.database.transaction(async (tx) => {
        if (!(await lockActiveMaintenanceJob(tx, jobId))) return false;

        await tx.delete(favorites).where(eq(favorites.subjectType, "library_entry"));
        await tx.delete(viewerState).where(eq(viewerState.subjectType, "library_entry"));
        await tx.delete(syncRunItems);
        await tx.delete(syncRuns);
        await tx.delete(libraryEntries);
        await tx.delete(folders);
        await tx.delete(mediaObjects);

        return true;
      });

      if (!active) return false;

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

/**
 * Lock the job row until `tx` ends and report whether the job is still active,
 * so a cancel either lands before the transaction's deletes or waits for them.
 */
async function lockActiveMaintenanceJob(
  tx: Pick<Database, "select">,
  jobId: string,
): Promise<boolean> {
  const [job] = await tx
    .select({ id: maintenanceJobs.id })
    .from(maintenanceJobs)
    .where(
      and(eq(maintenanceJobs.id, jobId), inArray(maintenanceJobs.status, [...activeJobStatuses])),
    )
    .for("update");

  return Boolean(job);
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
