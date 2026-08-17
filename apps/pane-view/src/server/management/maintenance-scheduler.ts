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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
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
    if (isUniqueViolation(error)) {
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
