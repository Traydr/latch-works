import { count, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  collections,
  folders,
  libraryEntries,
  mediaObjects,
  thumbnails,
} from "../db/schema";
import { readActiveCleanupJob } from "./guards";
import { listRunningSyncRuns, type RunningSyncRun } from "./sync-run-control";

export interface ManagementOverview {
  activeCleanupJob: {
    errorCount: number;
    id: string;
    phase: string;
    processedCount: number;
    status: "pending" | "running";
  } | null;
  activeSyncRun: {
    id: string;
    sourceRoot: string;
  } | null;
  runningSyncRuns: RunningSyncRun[];
  library: {
    activeEntries: number;
    activeFolders: number;
    collections: number;
    softDeletedEntries: number;
  };
  storage: {
    mediaObjectBytes: number;
    mediaObjectCount: number;
    thumbnailCount: number;
  };
  thumbnails: {
    failed: number;
    pending: number;
    processing: number;
    ready: number;
  };
}

export async function readManagementOverview(): Promise<ManagementOverview> {
  const [
    activeEntriesRow,
    softDeletedEntriesRow,
    activeFoldersRow,
    collectionsRow,
    mediaObjectStats,
    thumbnailCountRow,
    thumbnailStatusRows,
    runningSyncRuns,
    activeCleanupJob,
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(libraryEntries)
      .where(isNull(libraryEntries.deletedAt)),
    db
      .select({ value: count() })
      .from(libraryEntries)
      .where(isNotNull(libraryEntries.deletedAt)),
    db.select({ value: count() }).from(folders).where(isNull(folders.deletedAt)),
    db.select({ value: count() }).from(collections),
    db
      .select({
        bytes: sql<number>`coalesce(sum(${mediaObjects.size}), 0)`,
        count: count(),
      })
      .from(mediaObjects),
    db.select({ value: count() }).from(thumbnails),
    db
      .select({
        status: thumbnails.status,
        value: count(),
      })
      .from(thumbnails)
      .groupBy(thumbnails.status),
    listRunningSyncRuns(),
    readActiveCleanupJob(),
  ]);

  const activeSyncRun = runningSyncRuns[0]
    ? {
        id: runningSyncRuns[0].id,
        sourceRoot: runningSyncRuns[0].sourceRoot,
      }
    : null;

  const thumbnailCounts = {
    failed: 0,
    pending: 0,
    processing: 0,
    ready: 0,
  };

  for (const row of thumbnailStatusRows) {
    if (row.status in thumbnailCounts) {
      thumbnailCounts[row.status as keyof typeof thumbnailCounts] = row.value;
    }
  }

  return {
    activeCleanupJob,
    activeSyncRun,
    runningSyncRuns,
    library: {
      activeEntries: activeEntriesRow[0]?.value ?? 0,
      activeFolders: activeFoldersRow[0]?.value ?? 0,
      collections: collectionsRow[0]?.value ?? 0,
      softDeletedEntries: softDeletedEntriesRow[0]?.value ?? 0,
    },
    storage: {
      mediaObjectBytes: Number(mediaObjectStats[0]?.bytes ?? 0),
      mediaObjectCount: mediaObjectStats[0]?.count ?? 0,
      thumbnailCount: thumbnailCountRow[0]?.value ?? 0,
    },
    thumbnails: thumbnailCounts,
  };
}
