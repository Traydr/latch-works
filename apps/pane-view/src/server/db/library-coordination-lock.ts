import { sql } from "drizzle-orm";
import type { Database } from "./index";

/**
 * Stable PostgreSQL advisory lock key for library-mutating startup coordination
 * (sync run start and hard-wipe scheduling). Transaction-scoped via pg_advisory_xact_lock.
 */
const LIBRARY_MUTATION_STARTUP_LOCK_KEY = 0x4c57_4d53; // "LWMS"

/** The transaction (or connection) the lock is taken on; the result rows are not read. */
type SqlExecutor = Pick<Database, "execute">;

export async function acquireLibraryMutationStartupLock(tx: SqlExecutor): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LIBRARY_MUTATION_STARTUP_LOCK_KEY})`);
}

/**
 * Advisory lock namespace ("LWMJ") for a maintenance job's claim; the job id
 * hash is the key. The worker holds it for a whole batch, external storage and
 * Shutter requests included (see claimMaintenanceJobBatch in cleanup-worker).
 */
export const MAINTENANCE_JOB_CLAIM_LOCK_NAMESPACE = 0x4c57_4d4a;

/**
 * Wait until no worker holds `jobId`'s claim, then hold it until `tx` ends, so
 * no batch of that job runs, or has a request in flight, while `tx` changes it.
 */
export async function acquireMaintenanceJobClaim(tx: SqlExecutor, jobId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${MAINTENANCE_JOB_CLAIM_LOCK_NAMESPACE}, hashtext(${jobId}))`,
  );
}
