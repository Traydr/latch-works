import { isNotNull } from "drizzle-orm";
import { folders, libraryEntries } from "../db/schema";
import {
  type MaintenanceJobDescriptor,
  type MaintenanceTransaction,
  scheduleMaintenanceJob,
} from "./maintenance-scheduler";

/** There is work when any library entry or folder is soft-deleted. */
export async function hasSoftDeletedEntries(tx: MaintenanceTransaction): Promise<boolean> {
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

  return Boolean(softDeletedFolder);
}

export const softDeletedPurgeDescriptor: MaintenanceJobDescriptor = {
  probe: hasSoftDeletedEntries,
  type: "soft_deleted_purge",
};

export function scheduleSoftDeletedPurge(): Promise<{
  jobId: string | null;
  phase: "empty" | "scheduled";
}> {
  return scheduleMaintenanceJob(softDeletedPurgeDescriptor);
}
