import type {
  ActiveMaintenanceJobStatus,
  MaintenanceJobStatus,
  MaintenanceJobType,
  MaintenanceProgressFor,
  SyncRunState,
} from "@/lib/library-jobs";

/**
 * What Pane View's management server functions and screens share: a cleanup
 * job's status, the overview, and the sync run history rows.
 * Environment-neutral; the job and run vocabulary itself is `@/lib/library-jobs`.
 */

interface CleanupJobStatusBase {
  completedAt: string | null;
  error: string | null;
  id: string;
  startedAt: string | null;
  status: MaintenanceJobStatus;
}

type CleanupJobStatusByType = {
  [Type in MaintenanceJobType]: CleanupJobStatusBase & {
    /** Null when the stored progress does not fit the job's type; `error` says why. */
    progress: MaintenanceProgressFor<Type> | null;
    type: Type;
  };
};

export type CleanupJobStatus = CleanupJobStatusByType[MaintenanceJobType];

export interface ActiveCleanupJob {
  id: string;
  /** The stored phase string as-is; the overview renders it, the worker validates it. */
  phase: string;
  processedCount: number;
  status: ActiveMaintenanceJobStatus;
}

export interface RunningSyncRun {
  id: string;
  sourceRoot: string;
  startedAt: string;
}

export interface SyncRunHistoryEntry {
  completedAt: string | null;
  counts: Record<string, number>;
  error: string | null;
  id: string;
  sourceRoot: string;
  startedAt: string;
  status: SyncRunState;
}

export interface ManagementOverview {
  activeCleanupJob: ActiveCleanupJob | null;
  runningSyncRuns: RunningSyncRun[];
  /** Whether Shutter is configured, so its cached copies need purging. */
  shutterEnabled: boolean;
  library: {
    activeEntries: number;
    activeFolders: number;
    softDeletedEntries: number;
    softDeletedFolders: number;
  };
  storage: {
    mediaObjectBytes: number;
    mediaObjectCount: number;
    /** Stored originals no live entry references; the deleted-item purge reclaims them. */
    reclaimableMediaObjectCount: number;
  };
}
