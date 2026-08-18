import { z } from "zod";
import { type Database, db } from "../db";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { maintenanceJobs } from "../db/schema";
import { processMaintenanceJob } from "./cleanup-worker";
import { assertNoActiveSyncRun, readActiveCleanupJob } from "./guards";
import { initialProgressFor, type MaintenanceJobType } from "./maintenance-progress";

/**
 * The one place a maintenance job is scheduled (Plan 049, Step 4). Every job
 * type shares the prologue — transaction, library mutation startup lock,
 * "no active sync run", "no active cleanup job" — then runs its own optional
 * `prepare` and `probe` inside the same transaction, inserts the row with the
 * type's initial progress, and kicks the worker after commit. The unique
 * index on active jobs per type maps to the same "already in progress" error
 * for every type, so a race between two schedulers cannot surface as a raw
 * database error.
 */

export type MaintenanceTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The collaborators the scheduling prologue runs through. The default instance
 * wires the real database, lock, guards, and worker; a suite substitutes its
 * own to drive the prologue and the error mapping without a live archive.
 */
export interface MaintenanceSchedulerDependencies {
  acquireLibraryMutationStartupLock(tx: MaintenanceTransaction): Promise<void>;
  assertNoActiveSyncRun(tx: MaintenanceTransaction): Promise<void>;
  database: Pick<Database, "transaction">;
  processMaintenanceJob(jobId: string): void;
  readActiveCleanupJob(tx: MaintenanceTransaction): Promise<{ id: string } | null>;
}

export interface MaintenanceJobDescriptor {
  /** Work that must land in the scheduling transaction before the job row exists (library wipe). */
  prepare?(tx: MaintenanceTransaction): Promise<void>;
  /** Return true when there is work; runs inside the scheduling transaction after `prepare`. */
  probe(tx: MaintenanceTransaction): Promise<boolean>;
  type: MaintenanceJobType;
}

export interface ScheduleMaintenanceJobResult {
  jobId: string | null;
  phase: "empty" | "scheduled";
}

export const CLEANUP_IN_PROGRESS_MESSAGE = "A cleanup job is already in progress.";

/** The partial unique indexes that enforce one active job per type (migrations 0011, 0014). */
const ACTIVE_JOB_UNIQUE_INDEXES = new Set([
  "maintenance_jobs_active_type_unique",
  "maintenance_jobs_active_hard_wipe_unique",
]);

/** The facets of a PostgreSQL driver error the active-job check reads. */
const PgErrorFacetsSchema = z.object({
  code: z.string().optional(),
  constraint: z.string().optional(),
});

/** A thrown error that is, or wraps as `cause`, a PostgreSQL error. */
const ThrownPgErrorSchema = PgErrorFacetsSchema.extend({
  cause: PgErrorFacetsSchema.optional().catch(undefined),
});

/**
 * True for a unique violation raised by the active-job indexes — two
 * schedulers racing past the app-level guard. Other unique violations (a
 * descriptor's prepare step, for instance) are not "already in progress" and
 * are rethrown as they are. Drizzle surfaces the driver error as `cause` when
 * it wraps one, so both the error and its cause are checked.
 */
function isActiveJobUniqueViolation(error: Error): boolean {
  const parsed = ThrownPgErrorSchema.safeParse(error);
  if (!parsed.success) {
    return false;
  }
  return [parsed.data, parsed.data.cause].some(
    (candidate) =>
      candidate?.code === "23505" &&
      (candidate.constraint === undefined || ACTIVE_JOB_UNIQUE_INDEXES.has(candidate.constraint)),
  );
}

const defaultMaintenanceSchedulerDependencies: MaintenanceSchedulerDependencies = {
  acquireLibraryMutationStartupLock,
  assertNoActiveSyncRun,
  database: db,
  processMaintenanceJob,
  readActiveCleanupJob,
};

export async function scheduleMaintenanceJob(
  descriptor: MaintenanceJobDescriptor,
  dependencies: MaintenanceSchedulerDependencies = defaultMaintenanceSchedulerDependencies,
): Promise<ScheduleMaintenanceJobResult> {
  let jobId: string | null;
  try {
    jobId = await dependencies.database.transaction(async (tx) => {
      await dependencies.acquireLibraryMutationStartupLock(tx);
      await dependencies.assertNoActiveSyncRun(tx);

      if (await dependencies.readActiveCleanupJob(tx)) {
        throw new Error(CLEANUP_IN_PROGRESS_MESSAGE);
      }

      await descriptor.prepare?.(tx);

      if (!(await descriptor.probe(tx))) {
        return null;
      }

      const [job] = await tx
        .insert(maintenanceJobs)
        .values({
          progress: initialProgressFor(descriptor.type),
          status: "pending",
          type: descriptor.type,
        })
        .returning({ id: maintenanceJobs.id });

      if (!job) {
        throw new Error(`Unable to schedule ${descriptor.type}.`);
      }
      return job.id;
    });
  } catch (error) {
    if (error instanceof Error && isActiveJobUniqueViolation(error)) {
      throw new Error(CLEANUP_IN_PROGRESS_MESSAGE);
    }
    throw error;
  }

  if (!jobId) {
    return { jobId: null, phase: "empty" };
  }

  dependencies.processMaintenanceJob(jobId);
  return { jobId, phase: "scheduled" };
}
