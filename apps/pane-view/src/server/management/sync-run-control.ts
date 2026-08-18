import { and, asc, eq } from "drizzle-orm";
import { type Database, db } from "../db";
import { syncRuns } from "../db/schema";

const manualCancelMessage = "Manually cancelled from Pane View management.";

export interface RunningSyncRun {
  id: string;
  sourceRoot: string;
  startedAt: string;
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

  return rows.map((row) => ({
    id: row.id,
    sourceRoot: row.sourceRoot,
    startedAt: row.startedAt.toISOString(),
  }));
}

export async function forceCancelSyncRun(
  { syncRunId }: { syncRunId: string },
  database: Database = db,
): Promise<{ cancelled: boolean }> {
  const [syncRun] = await database
    .update(syncRuns)
    .set({
      completedAt: new Date(),
      error: manualCancelMessage,
      status: "cancelled",
    })
    .where(and(eq(syncRuns.id, syncRunId), eq(syncRuns.status, "running")))
    .returning({ id: syncRuns.id });

  return { cancelled: Boolean(syncRun) };
}

export async function forceCancelAllRunningSyncRuns(
  database: Database = db,
): Promise<{ cancelledCount: number }> {
  const cancelled = await database
    .update(syncRuns)
    .set({
      completedAt: new Date(),
      error: manualCancelMessage,
      status: "cancelled",
    })
    .where(eq(syncRuns.status, "running"))
    .returning({ id: syncRuns.id });

  return { cancelledCount: cancelled.length };
}
