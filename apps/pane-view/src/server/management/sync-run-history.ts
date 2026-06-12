import { desc } from "drizzle-orm";
import { db } from "../db";
import { syncRuns } from "../db/schema";

export interface SyncRunHistoryEntry {
  completedAt: string | null;
  counts: Record<string, number>;
  error: string | null;
  id: string;
  sourceRoot: string;
  startedAt: string;
  status: "running" | "completed" | "failed" | "cancelled";
}

export async function readSyncRunHistory({
  limit = 20,
}: {
  limit?: number;
} = {}): Promise<SyncRunHistoryEntry[]> {
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
    completedAt: row.completedAt?.toISOString() ?? null,
    counts: row.counts,
    error: row.error,
    id: row.id,
    sourceRoot: row.sourceRoot,
    startedAt: row.startedAt.toISOString(),
    status: row.status,
  }));
}
