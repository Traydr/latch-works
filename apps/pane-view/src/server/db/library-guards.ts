import { eq, inArray, sql } from "drizzle-orm";
import type { ActiveCleanupJob } from "@/features/management/management-contract";
import { ACTIVE_MAINTENANCE_JOB_STATUSES, isActiveMaintenanceJobStatus } from "@/lib/library-jobs";
import { type Database, db } from "./index";
import { acquireLibraryMutationStartupLock } from "./library-coordination-lock";
import { maintenanceJobs, syncRuns } from "./schema";

/*
 * The mutual exclusion between syncs, maintenance jobs, and other library
 * changes: a sync and a cleanup job must never run together, and nothing may
 * change the library under either.
 */

/** A maintenance job is running, so the library must not change underneath it. */
export class CleanupJobActiveError extends Error {
  constructor() {
    super(
      "A library cleanup job is still running. Wait for it to finish before changing the library.",
    );
    this.name = "CleanupJobActiveError";
  }
}

export async function assertNoActiveSyncRun(client: Database = db): Promise<void> {
  const runningSyncRuns = await client
    .select({ sourceRoot: syncRuns.sourceRoot })
    .from(syncRuns)
    .where(eq(syncRuns.status, "running"));

  if (runningSyncRuns.length === 0) {
    return;
  }

  if (runningSyncRuns.length === 1) {
    throw new Error(
      `A sync run is currently active (${runningSyncRuns[0]?.sourceRoot}). Stop it from sync run history or wait for it to finish before running maintenance.`,
    );
  }

  throw new Error(
    `${runningSyncRuns.length} sync runs are still marked running. Stop them from sync run history before running maintenance.`,
  );
}

export async function readActiveCleanupJob(
  client: Pick<Database, "select"> = db,
): Promise<ActiveCleanupJob | null> {
  const [job] = await client
    .select({
      id: maintenanceJobs.id,
      phase: sql<string | null>`${maintenanceJobs.progress}->>'phase'`,
      processedCount: sql<number | null>`(${maintenanceJobs.progress}->>'processedCount')::int`,
      status: maintenanceJobs.status,
    })
    .from(maintenanceJobs)
    .where(inArray(maintenanceJobs.status, [...ACTIVE_MAINTENANCE_JOB_STATUSES]))
    .limit(1);

  if (!job || !isActiveMaintenanceJobStatus(job.status)) {
    return null;
  }

  return {
    id: job.id,
    phase: job.phase ?? "",
    processedCount: job.processedCount ?? 0,
    status: job.status,
  };
}

export async function assertNoActiveCleanupJob(
  client: Pick<Database, "select"> = db,
): Promise<void> {
  if (await readActiveCleanupJob(client)) {
    throw new CleanupJobActiveError();
  }
}

/**
 * The prologue of a library change made from the web UI (deleting entries or
 * folders), run inside the change's own transaction: the startup lock the
 * maintenance schedulers take, so no job is scheduled between these checks and
 * the change, then "no sync run" (it would resurrect or fight the rows) and
 * "no cleanup job" (a purge may be hard-deleting the rows this marks).
 */
export async function guardLibraryChange(tx: Database): Promise<void> {
  await acquireLibraryMutationStartupLock(tx);
  await assertNoActiveSyncRun(tx);
  await assertNoActiveCleanupJob(tx);
}
