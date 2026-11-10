import { count, isNotNull, isNull, sql } from "drizzle-orm";
import type { ManagementOverview } from "@/features/management/management-contract";
import { db } from "../db";
import { readActiveCleanupJob } from "../db/library-guards";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import { shutterConfig } from "../media/shutter-config";
import { listRunningSyncRuns } from "../sync/sync-runs";
import { orphanedMediaObjectCondition } from "./orphaned-sources";

export async function readManagementOverview(): Promise<ManagementOverview> {
  const [
    activeEntriesRow,
    softDeletedEntriesRow,
    activeFoldersRow,
    softDeletedFoldersRow,
    mediaObjectStats,
    reclaimableMediaObjectsRow,
    runningSyncRuns,
    activeCleanupJob,
  ] = await Promise.all([
    db.select({ value: count() }).from(libraryEntries).where(isNull(libraryEntries.deletedAt)),
    db.select({ value: count() }).from(libraryEntries).where(isNotNull(libraryEntries.deletedAt)),
    db.select({ value: count() }).from(folders).where(isNull(folders.deletedAt)),
    db.select({ value: count() }).from(folders).where(isNotNull(folders.deletedAt)),
    db
      .select({
        bytes: sql<number>`coalesce(sum(${mediaObjects.size}), 0)`,
        count: count(),
      })
      .from(mediaObjects),
    db.select({ value: count() }).from(mediaObjects).where(orphanedMediaObjectCondition()),
    listRunningSyncRuns(),
    readActiveCleanupJob(),
  ]);

  return {
    activeCleanupJob,
    runningSyncRuns,
    shutterEnabled: shutterConfig.mode === "on",
    library: {
      activeEntries: activeEntriesRow[0]?.value ?? 0,
      activeFolders: activeFoldersRow[0]?.value ?? 0,
      softDeletedEntries: softDeletedEntriesRow[0]?.value ?? 0,
      softDeletedFolders: softDeletedFoldersRow[0]?.value ?? 0,
    },
    storage: {
      mediaObjectBytes: Number(mediaObjectStats[0]?.bytes ?? 0),
      mediaObjectCount: mediaObjectStats[0]?.count ?? 0,
      reclaimableMediaObjectCount: reclaimableMediaObjectsRow[0]?.value ?? 0,
    },
  };
}
