import { sql } from "drizzle-orm";
import type { Database } from "./index";

/**
 * Stable PostgreSQL advisory lock key for library-mutating startup coordination
 * (sync run start and hard-wipe scheduling). Transaction-scoped via pg_advisory_xact_lock.
 */
export const LIBRARY_MUTATION_STARTUP_LOCK_KEY = 0x4c57_4d53; // "LWMS"

/** The transaction (or connection) the lock is taken on; the result rows are not read. */
type SqlExecutor = Pick<Database, "execute">;

export async function acquireLibraryMutationStartupLock(tx: SqlExecutor): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LIBRARY_MUTATION_STARTUP_LOCK_KEY})`);
}
