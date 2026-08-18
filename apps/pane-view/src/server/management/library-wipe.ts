import { eq, isNull } from "drizzle-orm";
import { assertSyncApiTokenFromBody } from "../auth/api-token";
import {
  collectionItems,
  collections,
  favorites,
  folders,
  libraryEntries,
  viewerState,
} from "../db/schema";
import {
  type MaintenanceJobDescriptor,
  type MaintenanceSchedulerDependencies,
  type MaintenanceTransaction,
  maintenanceSchedulerDependencies,
  scheduleMaintenanceJob,
} from "./maintenance-scheduler";

export const LIBRARY_WIPE_CONFIRMATION = "WIPE LIBRARY";

/** The token check and the scheduler a wipe request runs through. */
export interface LibraryWipeDependencies {
  assertSyncApiToken(token: string): void;
  scheduler: MaintenanceSchedulerDependencies;
}

const defaultLibraryWipeDependencies: LibraryWipeDependencies = {
  assertSyncApiToken: assertSyncApiTokenFromBody,
  scheduler: maintenanceSchedulerDependencies,
};

/**
 * Soft-delete every entry and folder and drop the derived rows inside the
 * scheduling transaction, so the archive is gone from the gallery the moment
 * the wipe is accepted and the worker only has storage and hard deletes left.
 */
export async function softDeleteWholeLibrary(tx: MaintenanceTransaction): Promise<void> {
  const now = new Date();

  await tx.update(libraryEntries).set({ deletedAt: now }).where(isNull(libraryEntries.deletedAt));
  await tx.update(folders).set({ deletedAt: now }).where(isNull(folders.deletedAt));
  await tx.delete(collectionItems);
  await tx.delete(collections);
  await tx.delete(favorites).where(eq(favorites.subjectType, "library_entry"));
  await tx.delete(viewerState).where(eq(viewerState.subjectType, "library_entry"));
}

export const libraryWipeDescriptor: MaintenanceJobDescriptor = {
  prepare: softDeleteWholeLibrary,
  // A wipe always has work: the storage sweep and the hard delete run even
  // when the library was already empty.
  probe: async () => true,
  type: "library_hard_wipe",
};

export async function scheduleLibraryWipe(
  { confirmation, syncToken }: { confirmation: string; syncToken: string },
  dependencies: LibraryWipeDependencies = defaultLibraryWipeDependencies,
): Promise<{ jobId: string; phase: "scheduled" }> {
  // Input validation stays outside the scheduler: it is about the request,
  // not about when a job may start.
  if (confirmation !== LIBRARY_WIPE_CONFIRMATION) {
    throw new Error(`Type "${LIBRARY_WIPE_CONFIRMATION}" to confirm.`);
  }
  dependencies.assertSyncApiToken(syncToken);

  const { jobId } = await scheduleMaintenanceJob(libraryWipeDescriptor, dependencies.scheduler);
  if (!jobId) {
    throw new Error("Unable to schedule library wipe.");
  }
  return { jobId, phase: "scheduled" };
}
