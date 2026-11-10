import type { SyncRunStatus } from "@latch-works/sync-protocol";
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import type {
  RunningSyncRun,
  SyncRunHistoryEntry,
} from "@/features/management/management-contract";
import { type Database, db } from "../db";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { assertNoActiveCleanupJob } from "../db/library-guards";
import { folders, syncRuns } from "../db/schema";
import { occupiedFolderPaths } from "../library/folder-path-sql";
import { SyncRunConflictError, SyncRunNotFoundError } from "./errors";

const manualCancelMessage = "Manually cancelled from Pane View management.";

export interface StartSyncRunInput {
  counts: Record<string, number>;
  sourceRoot: string;
}

/** How a client says its run ended. */
export interface FinalizeSyncRunBody {
  counts: Record<string, number>;
  error: string | null;
  status: SyncRunStatus;
}

export async function startSyncRun(
  input: StartSyncRunInput,
  database: Database = db,
): Promise<{ syncRunId: string }> {
  return database.transaction(async (tx) => {
    await acquireLibraryMutationStartupLock(tx);
    await assertNoActiveCleanupJob(tx);

    const [syncRun] = await tx
      .insert(syncRuns)
      .values({ counts: input.counts, sourceRoot: input.sourceRoot, status: "running" })
      .returning({ id: syncRuns.id });

    if (!syncRun) {
      throw new Error("Unable to create sync run.");
    }

    return { syncRunId: syncRun.id };
  });
}

/**
 * Sync only creates a folder row for a folder that holds files, so a folder
 * with no live entry anywhere beneath it was emptied or renamed locally.
 * Soft-delete it with the entries that left it, or it lingers as an empty card
 * and stops its parent counting as a comic leaf.
 */
async function softDeleteEmptiedFolders(tx: Pick<Database, "select" | "update">): Promise<void> {
  const occupiedPaths = occupiedFolderPaths(tx, { countLiveFolders: false });

  await tx
    .update(folders)
    .set({ deletedAt: new Date() })
    .where(and(isNull(folders.deletedAt), sql`${folders.path} not in (${occupiedPaths})`));
}

/**
 * Ends the running runs `scope` selects, the way every run ends, finalized by
 * its client or cancelled from Manage: with its outcome recorded and its
 * emptied folders dropped. Returns how many runs it ended.
 */
async function endRunningSyncRuns(
  scope: SQL | undefined,
  outcome: Pick<FinalizeSyncRunBody, "error" | "status"> & { counts?: Record<string, number> },
  database: Database,
): Promise<number> {
  return database.transaction(async (tx) => {
    const ended = await tx
      .update(syncRuns)
      .set({ ...outcome, completedAt: new Date() })
      .where(and(eq(syncRuns.status, "running"), scope))
      .returning({ id: syncRuns.id });

    if (ended.length > 0) {
      await softDeleteEmptiedFolders(tx);
    }

    return ended.length;
  });
}

/** A replay of the outcome a run already has succeeds; any other outcome is a conflict. */
export async function finalizeSyncRun(
  syncRunId: string,
  outcome: FinalizeSyncRunBody,
  database: Database = db,
): Promise<void> {
  if ((await endRunningSyncRuns(eq(syncRuns.id, syncRunId), outcome, database)) > 0) {
    return;
  }

  const [existingSyncRun] = await database
    .select({ status: syncRuns.status })
    .from(syncRuns)
    .where(eq(syncRuns.id, syncRunId))
    .limit(1);

  if (!existingSyncRun) {
    throw new SyncRunNotFoundError();
  }

  if (existingSyncRun.status !== outcome.status) {
    throw new SyncRunConflictError(`Sync run is already ${existingSyncRun.status}.`);
  }
}

/** A cancel from Manage keeps the counts the run started with. */
const manualCancel = { error: manualCancelMessage, status: "cancelled" } as const;

export async function forceCancelSyncRun(
  { syncRunId }: { syncRunId: string },
  database: Database = db,
): Promise<{ cancelled: boolean }> {
  const cancelled = await endRunningSyncRuns(eq(syncRuns.id, syncRunId), manualCancel, database);

  return { cancelled: cancelled > 0 };
}

export async function forceCancelAllRunningSyncRuns(
  database: Database = db,
): Promise<{ cancelledCount: number }> {
  return { cancelledCount: await endRunningSyncRuns(undefined, manualCancel, database) };
}

export async function listRunningSyncRuns(database: Database = db): Promise<RunningSyncRun[]> {
  const rows = await database
    .select({
      id: syncRuns.id,
      sourceRoot: syncRuns.sourceRoot,
      startedAt: syncRuns.startedAt,
    })
    .from(syncRuns)
    .where(eq(syncRuns.status, "running"))
    .orderBy(asc(syncRuns.startedAt));

  return rows.map((row) => ({ ...row, startedAt: row.startedAt.toISOString() }));
}

export async function readSyncRunHistory(limit = 20): Promise<SyncRunHistoryEntry[]> {
  const rows = await db
    .select({
      completedAt: syncRuns.completedAt,
      counts: syncRuns.counts,
      error: syncRuns.error,
      id: syncRuns.id,
      sourceRoot: syncRuns.sourceRoot,
      startedAt: syncRuns.startedAt,
      status: syncRuns.status,
    })
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    completedAt: row.completedAt?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
  }));
}
