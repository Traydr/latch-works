import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { cancelMaintenanceJob } from "../../server/management/cleanup-control";
import {
  processMaintenanceJob,
  readCleanupJobStatus,
  resumePendingMaintenanceJobs,
} from "../../server/management/cleanup-worker";
import {
  countEntriesUnderPaths,
  softDeleteFolderSubtree,
} from "../../server/management/folder-delete";
import { scheduleLibraryWipe } from "../../server/management/library-wipe";
import { readManagementOverview } from "../../server/management/overview";
import { scheduleShutterSourcePurge } from "../../server/management/shutter-source-purge";
import { scheduleSoftDeletedPurge } from "../../server/management/soft-deleted-purge";
import {
  forceCancelAllRunningSyncRuns,
  forceCancelSyncRun,
} from "../../server/management/sync-run-control";
import { readSyncRunHistory } from "../../server/management/sync-run-history";
import { assertWebSessionAuthorized } from "../auth/assert-web-session";

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

export const getManagementOverview = createServerFn({ method: "GET" }).handler(async () => {
  await assertWebSessionAuthorized();
  await resumePendingMaintenanceJobs();

  return readManagementOverview();
});

export const getSyncRunHistory = createServerFn({ method: "GET" }).handler(async () => {
  await assertWebSessionAuthorized();

  return readSyncRunHistory();
});

export const deleteFolders = createServerFn({ method: "POST" })
  .validator(folderDeleteSchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();

    return softDeleteFolderSubtree({ folderPaths: data.folderPaths });
  });

export const countFolderEntries = createServerFn({ method: "GET" })
  .validator(folderDeleteSchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();

    return { count: await countEntriesUnderPaths(data.folderPaths) };
  });

export const wipeLibrary = createServerFn({ method: "POST" })
  .validator(wipeLibrarySchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();

    return scheduleLibraryWipe({
      confirmation: data.confirmation,
      syncToken: data.syncToken,
    });
  });

export const purgeSoftDeletedItems = createServerFn({ method: "POST" }).handler(async () => {
  await assertWebSessionAuthorized();

  return scheduleSoftDeletedPurge();
});

export const purgeDeletedShutterSources = createServerFn({ method: "POST" }).handler(async () => {
  await assertWebSessionAuthorized();

  return scheduleShutterSourcePurge();
});

export const cancelCleanupJob = createServerFn({ method: "POST" })
  .validator(cleanupJobSchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();
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
    const result = await forceCancelSyncRun({ syncRunId: data.syncRunId });

    if (!result.cancelled) {
      throw new Error("Sync run is not running or no longer exists.");
    }

    return result;
  });

export const cancelAllRunningSyncRuns = createServerFn({ method: "POST" }).handler(async () => {
  await assertWebSessionAuthorized();

  return forceCancelAllRunningSyncRuns();
});

export const getCleanupJobStatus = createServerFn({ method: "GET" })
  .validator(cleanupJobSchema)
  .handler(async ({ data }) => {
    await assertWebSessionAuthorized();
    const status = await readCleanupJobStatus({ jobId: data.jobId });

    if (!status) {
      throw new Error("Cleanup job not found.");
    }

    if (status.status === "pending" || status.status === "running") {
      processMaintenanceJob(status.id);
    }

    return status;
  });
