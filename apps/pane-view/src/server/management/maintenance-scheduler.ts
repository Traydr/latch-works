import { db } from "../db";
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

export type MaintenanceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

/**
 * True for a unique violation raised by the active-job indexes — two
 * schedulers racing past the app-level guard. Other unique violations (a
 * descriptor's prepare step, for instance) are not "already in progress" and
 * are rethrown as they are. Drizzle surfaces the driver error as `cause` when
 * it wraps one, so both shapes are checked.
 */
function isActiveJobUniqueViolation(error: unknown): boolean {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const { code, constraint } = candidate as { code?: string; constraint?: string };
    if (
      code === "23505" &&
      (constraint === undefined || ACTIVE_JOB_UNIQUE_INDEXES.has(constraint))
    ) {
      return true;
    }
  }
  return false;
}

export async function scheduleMaintenanceJob(
  descriptor: MaintenanceJobDescriptor,
): Promise<ScheduleMaintenanceJobResult> {
  let jobId: string | null;
  try {
    jobId = await db.transaction(async (tx) => {
      await acquireLibraryMutationStartupLock(tx);
      await assertNoActiveSyncRun(tx);

      if (await readActiveCleanupJob(tx)) {
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
    if (isActiveJobUniqueViolation(error)) {
      throw new Error(CLEANUP_IN_PROGRESS_MESSAGE);
    }
    throw error;
  }

  if (!jobId) {
    return { jobId: null, phase: "empty" };
  }

  processMaintenanceJob(jobId);
  return { jobId, phase: "scheduled" };
}
