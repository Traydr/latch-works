import { isNull } from "drizzle-orm";
import { assertSyncApiTokenFromBody } from "../auth/api-token";
import { type Database, db } from "../db";
import { folders, libraryEntries } from "../db/schema";
import {
  type MaintenanceJobDescriptor,
  type MaintenanceTransaction,
  scheduleMaintenanceJob,
} from "./maintenance-scheduler";

export const LIBRARY_WIPE_CONFIRMATION = "WIPE LIBRARY";

/**
 * Soft-delete every entry and folder inside the scheduling transaction, so the archive is gone from the gallery the moment
 * the wipe is accepted and the worker only has storage and hard deletes left.
 */
async function softDeleteWholeLibrary(tx: MaintenanceTransaction): Promise<void> {
  const now = new Date();

  await tx.update(libraryEntries).set({ deletedAt: now }).where(isNull(libraryEntries.deletedAt));
  await tx.update(folders).set({ deletedAt: now }).where(isNull(folders.deletedAt));
}

const libraryWipeDescriptor: MaintenanceJobDescriptor = {
  prepare: softDeleteWholeLibrary,
  // A wipe always has work: the storage sweep and the hard delete run even
  // when the library was already empty.
  probe: async () => true,
  type: "library_hard_wipe",
};

export async function scheduleLibraryWipe(
  { confirmation, syncToken }: { confirmation: string; syncToken: string },
  database: Database = db,
): Promise<{ jobId: string; phase: "scheduled" }> {
  if (confirmation !== LIBRARY_WIPE_CONFIRMATION) {
    throw new Error(`Type "${LIBRARY_WIPE_CONFIRMATION}" to confirm.`);
  }

  assertSyncApiTokenFromBody(syncToken);

  const { jobId } = await scheduleMaintenanceJob(libraryWipeDescriptor, database);

  if (!jobId) {
    throw new Error("Unable to schedule library wipe.");
  }

  return { jobId, phase: "scheduled" };
}
