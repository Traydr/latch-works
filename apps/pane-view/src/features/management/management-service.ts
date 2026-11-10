import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { assertWebSessionAuthorized } from "../auth/assert-web-session";
import type {
  CleanupJobStatus,
  ManagementOverview,
  SyncRunHistoryEntry,
} from "./management-contract";

/*
 * The management screen's server functions. Server modules load lazily, so
 * this file stays out of the client bundle's server graph.
 */

const folderDeleteSchema = z.object({
  folderPaths: z.array(z.string().min(1)).min(1),
});

const wipeLibrarySchema = z.object({
  confirmation: z.string(),
  syncToken: z.string().min(1),
});

const cleanupJobSchema = z.object({
  jobId: z.uuid(),
});

const cancelSyncRunSchema = z.object({
  syncRunId: z.uuid(),
});

export const getManagementOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<ManagementOverview> => {
    await assertWebSessionAuthorized();

    const { readManagementOverview } = await import("../../server/management/overview");

    return readManagementOverview();
  },
);

export const getSyncRunHistory = createServerFn({ method: "GET" }).handler(
  async (): Promise<SyncRunHistoryEntry[]> => {
    await assertWebSessionAuthorized();

    const { readSyncRunHistory } = await import("../../server/sync/sync-runs");

    return readSyncRunHistory();
  },
);

export const deleteFolders = createServerFn({ method: "POST" })
  .validator(folderDeleteSchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();

    const { softDeleteFolderSubtree } = await import("../../server/management/folder-delete");

    return softDeleteFolderSubtree({ folderPaths: data.folderPaths });
  });

export const countFolderEntries = createServerFn({ method: "GET" })
  .validator(folderDeleteSchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();

    const { countEntriesUnderPaths } = await import("../../server/management/folder-delete");

    return { count: await countEntriesUnderPaths(data.folderPaths) };
  });

export const wipeLibrary = createServerFn({ method: "POST" })
  .validator(wipeLibrarySchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();

    const { scheduleLibraryWipe } = await import("../../server/management/library-wipe");

    return scheduleLibraryWipe({ confirmation: data.confirmation, syncToken: data.syncToken });
  });

export const purgeSoftDeletedItems = createServerFn({ method: "POST" }).handler(async () => {
  await assertWebSessionAuthorized();

  const { scheduleSoftDeletedPurge } = await import("../../server/management/soft-deleted-purge");

  return scheduleSoftDeletedPurge();
});

export const purgeDeletedShutterSources = createServerFn({ method: "POST" }).handler(async () => {
  await assertWebSessionAuthorized();

  const { scheduleShutterSourcePurge } = await import(
    "../../server/management/shutter-source-purge"
  );

  return scheduleShutterSourcePurge();
});

export const cancelCleanupJob = createServerFn({ method: "POST" })
  .validator(cleanupJobSchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();

    const { cancelMaintenanceJob } = await import("../../server/management/cleanup-control");
    const result = await cancelMaintenanceJob({ jobId: data.jobId });

    if (!result.cancelled) {
      throw new Error("Cleanup job is not running or no longer exists.");
    }

    return result;
  });

export const cancelSyncRun = createServerFn({ method: "POST" })
  .validator(cancelSyncRunSchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();

    const { forceCancelSyncRun } = await import("../../server/sync/sync-runs");
    const result = await forceCancelSyncRun({ syncRunId: data.syncRunId });

    if (!result.cancelled) {
      throw new Error("Sync run is not running or no longer exists.");
    }

    return result;
  });

export const cancelAllRunningSyncRuns = createServerFn({ method: "POST" }).handler(async () => {
  await assertWebSessionAuthorized();

  const { forceCancelAllRunningSyncRuns } = await import("../../server/sync/sync-runs");

  return forceCancelAllRunningSyncRuns();
});

export const getCleanupJobStatus = createServerFn({ method: "GET" })
  .validator(cleanupJobSchema)
  .handler(async ({ data }): Promise<CleanupJobStatus> => {
    await assertWebSessionAuthorized();

    const { readCleanupJobStatus } = await import("../../server/management/cleanup-worker");
    const status = await readCleanupJobStatus({ jobId: data.jobId });

    if (!status) {
      throw new Error("Cleanup job not found.");
    }

    return status;
  });
