import { isNotNull } from "drizzle-orm";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import {
  type MaintenanceJobDescriptor,
  type MaintenanceTransaction,
  scheduleMaintenanceJob,
} from "./maintenance-scheduler";
import { orphanedMediaObjectCondition } from "./orphaned-sources";

/**
 * There is work when any library entry or folder is soft-deleted, or when an
 * original no live entry references is still stored (a content change leaves
 * the old one behind without deleting anything).
 */
export async function hasSoftDeletedPurgeWork(tx: MaintenanceTransaction): Promise<boolean> {
  const [softDeletedEntry] = await tx
    .select({ id: libraryEntries.id })
    .from(libraryEntries)
    .where(isNotNull(libraryEntries.deletedAt))
    .limit(1);

  if (softDeletedEntry) {
    return true;
  }

  const [softDeletedFolder] = await tx
    .select({ id: folders.id })
    .from(folders)
    .where(isNotNull(folders.deletedAt))
    .limit(1);

  if (softDeletedFolder) {
    return true;
  }

  const [orphanedMediaObject] = await tx
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(orphanedMediaObjectCondition())
    .limit(1);

  return Boolean(orphanedMediaObject);
}

const softDeletedPurgeDescriptor: MaintenanceJobDescriptor = {
  probe: hasSoftDeletedPurgeWork,
  type: "soft_deleted_purge",
};

export function scheduleSoftDeletedPurge(): Promise<{
  jobId: string | null;
  phase: "empty" | "scheduled";
}> {
  return scheduleMaintenanceJob(softDeletedPurgeDescriptor);
}
