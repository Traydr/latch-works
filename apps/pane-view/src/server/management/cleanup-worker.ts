import { ORIGINALS_PREFIX } from "@latch-works/sync-protocol";
import { and, eq, inArray, isNotNull, isNull, not, sql } from "drizzle-orm";
import type { CleanupJobStatus } from "@/features/management/management-contract";
import type { JsonValue } from "@/lib/json";
import {
  ACTIVE_MAINTENANCE_JOB_STATUSES,
  type LibraryWipeJobProgress,
  type MaintenanceJobProgress,
  type MaintenanceJobType,
  type MaintenanceProgressFor,
  parseMaintenanceProgress,
  type ShutterSourcePurgeJobProgress,
  type SoftDeletedPurgeJobProgress,
} from "@/lib/library-jobs";
import { type Database, db } from "../db";
import { MAINTENANCE_JOB_CLAIM_LOCK_NAMESPACE } from "../db/library-coordination-lock";
import {
  folders,
  libraryEntries,
  maintenanceJobs,
  mediaObjects,
  shutterSourceCleanup,
  syncRunItems,
  syncRuns,
} from "../db/schema";
import { occupiedFolderPaths } from "../library/folder-path-sql";
import { purgeShutterSource, type ShutterPurgeSource } from "../media/shutter-client";
import { type ShutterConfig, shutterConfig } from "../media/shutter-config";
import {
  deleteStoredObjects,
  type ListStoredObjectsPage,
  listStoredObjectsByPrefix,
} from "../media/storage-client";
import {
  liveShutterSourceCondition,
  orphanedMediaObjectCondition,
  orphanedShutterSourceCondition,
} from "./orphaned-sources";

const batchSize = 25;

const nextBatchDelayMs = 25;

/** How long to wait before retrying a job whose claim another worker holds. */
const contendedRetryDelayMs = 30_000;

const deleteConcurrency = 8;

let resumeStarted = false;

const runningJobs = new Set<string>();

/**
 * Everything a maintenance batch reaches outside its own module: the archive
 * database, the object storage deletes and listing, and Shutter. The default
 * instance wires the real ones; a suite passes a pglite database and fakes for
 * the two external services.
 */
export interface MaintenanceWorkerDependencies {
  /**
   * Run `batch` while holding the job's claim, or resolve "contended" without
   * running it when another worker holds the claim.
   */
  claimJobBatch(jobId: string, batch: () => Promise<boolean>): Promise<boolean | "contended">;
  database: Database;
  deleteObjects(keys: string[]): Promise<void>;
  listObjectsByPrefix(request: {
    continuationToken?: string;
    limit: number;
    prefix: string;
  }): Promise<ListStoredObjectsPage>;
  /** Purges Shutter's copies of a source; null when Shutter is off and holds none. */
  purgeShutterSource: ((source: ShutterPurgeSource) => Promise<void>) | null;
}

function shutterPurger(
  shutter: ShutterConfig,
): MaintenanceWorkerDependencies["purgeShutterSource"] {
  return shutter.mode === "on" ? (source) => purgeShutterSource(source, shutter) : null;
}

const defaultMaintenanceWorkerDependencies: MaintenanceWorkerDependencies = {
  claimJobBatch: (jobId, batch) => claimMaintenanceJobBatch(db, jobId, batch),
  database: db,
  deleteObjects: (keys) => deleteStoredObjects({ keys, maxConcurrent: deleteConcurrency }),
  listObjectsByPrefix: (request) => listStoredObjectsByPrefix(request),
  purgeShutterSource: shutterPurger(shutterConfig),
};

type MaintenanceJobRunners = {
  [Type in MaintenanceJobType]: (
    jobId: string,
    progress: MaintenanceProgressFor<Type>,
    dependencies: MaintenanceWorkerDependencies,
  ) => Promise<boolean>;
};

/** Each job type's batch; the lookup goes through a generic `Type`, so it only sees its own progress. */
const maintenanceJobRunners: MaintenanceJobRunners = {
  library_hard_wipe: processLibraryWipeBatch,
  shutter_source_purge: processShutterSourcePurgeBatch,
  soft_deleted_purge: processSoftDeletedPurgeBatch,
};

export async function readCleanupJobStatus(
  { jobId }: { jobId: string },
  database: Database = db,
): Promise<CleanupJobStatus | null> {
  const [job] = await database
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

  const parsed = parseMaintenanceProgress(job.type, job.progress);

  // SAFETY: parseMaintenanceProgress's overload ties the progress to job.type.
  return {
    completedAt: job.completedAt?.toISOString() ?? null,
    error: job.error,
    id: job.id,
    progress: parsed.ok ? parsed.progress : null,
    startedAt: job.startedAt?.toISOString() ?? null,
    status: job.status,
    type: job.type,
  } as CleanupJobStatus;
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
      .where(inArray(maintenanceJobs.status, [...ACTIVE_MAINTENANCE_JOB_STATUSES]));
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
 * through the pool. The in-memory set only keeps this process from
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

/** Run one batch of `jobId`. Resolves true when another batch should follow. */
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

  return runJobBatch(job.type, jobId, job.progress, dependencies);
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

  return maintenanceJobRunners[type](jobId, parsed.progress, dependencies);
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

      if (!(await isMaintenanceJobActive(jobId, dependencies.database))) return false;

      await dependencies.deleteObjects(rows.map((row) => row.objectKey));

      for (const row of rows) {
        // Deleting the media row cascades its soft-deleted library entries, whose
        // viewer state goes with them. A cancel stops the batch before its next media row.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each transaction advances the durable cleanup cursor.
        const active = await dependencies.database.transaction(async (tx) => {
          if (!(await isMaintenanceJobActive(jobId, tx, { lock: true }))) return false;

          await tx
            .insert(shutterSourceCleanup)
            .values({ objectKey: row.objectKey, sha256: row.sha256 })
            .onConflictDoNothing();
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
      const active = await dependencies.database.transaction(async (tx) => {
        if (!(await isMaintenanceJobActive(jobId, tx, { lock: true }))) return false;

        await tx.delete(libraryEntries).where(isNotNull(libraryEntries.deletedAt));

        // A folder row cascades to its child folders, so a deleted folder that
        // still holds anything live (a re-synced file, a live subfolder) stays.
        const occupiedPaths = occupiedFolderPaths(tx, { countLiveFolders: true });

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

      if (!(await purgeQueuedShutterSources(jobId, rows, dependencies))) return false;

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
        const queuedSources = await purgeQueuedShutterSourceBatch(jobId, dependencies);

        if (queuedSources === "inactive") return false;

        if (queuedSources > 0) {
          await updateJobProgress(
            jobId,
            { ...progress, processedCount: progress.processedCount + queuedSources },
            dependencies,
          );

          return true;
        }

        await updateJobProgress(jobId, { ...progress, phase: "s3_orphan_sweep" }, dependencies);

        return true;
      }

      if (!(await isMaintenanceJobActive(jobId, dependencies.database))) return false;

      await dependencies.deleteObjects(rows.map((row) => row.objectKey));

      for (const row of rows) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- A cancel stops the batch before its next purge and delete.
        if (!(await isMaintenanceJobActive(jobId, dependencies.database))) return false;

        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Stop at the first purge failure so the durable job cursor remains retry-safe.
        await purgeOrQueueShutterCopies(row, dependencies);

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
        prefix: ORIGINALS_PREFIX,
      });

      if (page.keys.length > 0) {
        if (!(await isMaintenanceJobActive(jobId, dependencies.database))) return false;

        await dependencies.deleteObjects(page.keys);

        if (!(await isMaintenanceJobActive(jobId, dependencies.database))) return false;

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
        if (!(await isMaintenanceJobActive(jobId, tx, { lock: true }))) return false;

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

/**
 * Purge one batch of Shutter sources still waiting in the cleanup queue. An
 * earlier deleted-item purge queues a source when it deletes the media row, so
 * a wipe that only walked media rows would never find it. Resolves how many
 * sources Shutter confirmed, or "inactive" once the job was cancelled.
 */
async function purgeQueuedShutterSourceBatch(
  jobId: string,
  dependencies: MaintenanceWorkerDependencies,
): Promise<number | "inactive"> {
  if (dependencies.purgeShutterSource === null) return 0;

  const rows = await dependencies.database
    .select({ objectKey: shutterSourceCleanup.objectKey, sha256: shutterSourceCleanup.sha256 })
    .from(shutterSourceCleanup)
    .where(isNull(shutterSourceCleanup.purgedAt))
    .limit(batchSize);

  if (!(await purgeQueuedShutterSources(jobId, rows, dependencies))) return "inactive";

  return rows.length;
}

/**
 * Purge each queued Shutter source in `rows` and mark its queue row purged
 * once Shutter confirms, so the durable queue advances one confirmed source at
 * a time. Resolves false, before the next purge, once the job was cancelled.
 */
async function purgeQueuedShutterSources(
  jobId: string,
  rows: ShutterPurgeSource[],
  dependencies: MaintenanceWorkerDependencies,
): Promise<boolean> {
  for (const row of rows) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- A cancel stops the batch before its next purge.
    if (!(await isMaintenanceJobActive(jobId, dependencies.database))) return false;

    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Mark each source only after Shutter confirms its purge.
    await purgeShutterCopies(row, dependencies);

    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- The durable queue advances one confirmed source at a time.
    await dependencies.database
      .update(shutterSourceCleanup)
      .set({ purgedAt: new Date() })
      .where(eq(shutterSourceCleanup.sha256, row.sha256));
  }

  return true;
}

/**
 * Purge Shutter's copies of `source` now, or, with Shutter off, queue it for
 * the next Shutter source purge: what Shutter cached while it was on outlives
 * the setting, so the source must not be forgotten with its media row.
 */
async function purgeOrQueueShutterCopies(
  source: ShutterPurgeSource,
  dependencies: MaintenanceWorkerDependencies,
): Promise<void> {
  if (dependencies.purgeShutterSource !== null) {
    await purgeShutterCopies(source, dependencies);

    return;
  }

  await dependencies.database
    .insert(shutterSourceCleanup)
    .values({ objectKey: source.objectKey, sha256: source.sha256 })
    .onConflictDoNothing();
}

/** Purge Shutter's copies of `source`, if Shutter is on; a failure fails the batch. */
async function purgeShutterCopies(
  source: ShutterPurgeSource,
  dependencies: MaintenanceWorkerDependencies,
): Promise<void> {
  try {
    await dependencies.purgeShutterSource?.(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Shutter source purge failed: ${reason}`, { cause: error });
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
    .where(activeJob(jobId));
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
    .where(activeJob(jobId));
}

async function updateJobProgress(
  jobId: string,
  progress: MaintenanceJobProgress,
  dependencies: MaintenanceWorkerDependencies,
): Promise<void> {
  await dependencies.database.update(maintenanceJobs).set({ progress }).where(activeJob(jobId));
}

function activeJob(jobId: string) {
  return and(
    eq(maintenanceJobs.id, jobId),
    inArray(maintenanceJobs.status, [...ACTIVE_MAINTENANCE_JOB_STATUSES]),
  );
}

/**
 * Whether the job is still active. With `lock`, `client` must be a
 * transaction: the job row stays locked until it ends, so a cancel either
 * lands before the transaction's deletes or waits for them.
 */
async function isMaintenanceJobActive(
  jobId: string,
  client: Pick<Database, "select">,
  { lock = false }: { lock?: boolean } = {},
): Promise<boolean> {
  const query = client
    .select({ id: maintenanceJobs.id })
    .from(maintenanceJobs)
    .where(activeJob(jobId));

  const [job] = lock ? await query.for("update") : await query.limit(1);

  return Boolean(job);
}
