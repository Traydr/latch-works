import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { librarySnapshotKeys } from "../library/library-queries";
import {
  cancelAllRunningSyncRuns,
  cancelCleanupJob,
  cancelSyncRun,
  deleteFolders,
  getCleanupJobStatus,
  getManagementOverview,
  getSyncRunHistory,
  purgeSoftDeletedItems,
  wipeLibrary,
} from "./management-service";

export const managementKeys = {
  all: ["management"] as const,
  cleanupJob: (jobId: string) => [...managementKeys.all, "cleanup-job", jobId] as const,
  overview: () => [...managementKeys.all, "overview"] as const,
  syncHistory: () => [...managementKeys.all, "sync-history"] as const,
};

export function useManagementOverviewQuery() {
  return useQuery({
    queryKey: managementKeys.overview(),
    queryFn: () => getManagementOverview(),
    refetchInterval: (query) => {
      const overview = query.state.data;
      if (overview?.activeCleanupJob || (overview?.runningSyncRuns.length ?? 0) > 0) {
        return 3_000;
      }
      return false;
    },
  });
}

export function useSyncRunHistoryQuery() {
  return useQuery({
    queryKey: managementKeys.syncHistory(),
    queryFn: () => getSyncRunHistory(),
    refetchInterval: (query) => {
      const runs = query.state.data;
      if (runs?.some((run) => run.status === "running")) {
        return 5_000;
      }
      return false;
    },
  });
}

export function useCleanupJobStatusQuery(jobId: string | null) {
  return useQuery({
    enabled: Boolean(jobId),
    queryKey: managementKeys.cleanupJob(jobId ?? "none"),
    queryFn: () => getCleanupJobStatus({ data: { jobId: jobId ?? "" } }),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "pending" || status === "running") {
        return 2_000;
      }
      return false;
    },
  });
}

export function useCancelCleanupJobMutation() {
  const invalidate = useInvalidateManagement();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (jobId: string) => cancelCleanupJob({ data: { jobId } }),
    onSuccess: (_result, jobId) => {
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: managementKeys.cleanupJob(jobId) });
    },
  });
}

function useInvalidateManagement() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: managementKeys.all });
}

export function useDeleteFoldersMutation() {
  const invalidate = useInvalidateManagement();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (folderPaths: string[]) => deleteFolders({ data: { folderPaths } }),
    onSuccess: () => {
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: librarySnapshotKeys.all });
    },
  });
}

export function useCancelSyncRunMutation() {
  const invalidate = useInvalidateManagement();

  return useMutation({
    mutationFn: (syncRunId: string) => cancelSyncRun({ data: { syncRunId } }),
    onSuccess: () => {
      void invalidate();
    },
  });
}

export function useCancelAllRunningSyncRunsMutation() {
  const invalidate = useInvalidateManagement();

  return useMutation({
    mutationFn: () => cancelAllRunningSyncRuns(),
    onSuccess: () => {
      void invalidate();
    },
  });
}

export function useWipeLibraryMutation() {
  const invalidate = useInvalidateManagement();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { confirmation: string; syncToken: string }) =>
      wipeLibrary({ data: input }),
    onSuccess: () => {
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: librarySnapshotKeys.all });
    },
  });
}

export function usePurgeSoftDeletedItemsMutation() {
  const invalidate = useInvalidateManagement();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => purgeSoftDeletedItems(),
    onSuccess: () => {
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: librarySnapshotKeys.all });
    },
  });
}
