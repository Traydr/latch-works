import type { MediaItem } from "@latch-works/media-domain";
import type {
  RemoteEntrySnapshot,
  ScanArchiveProgress,
  SyncPlanAction,
} from "@latch-works/media-index";

export interface LockstepPlanItem {
  action: SyncPlanAction;
  local?: MediaItem;
  path: string;
  remote?: RemoteEntrySnapshot;
}

export interface LockstepPlanCounts {
  delete: number;
  keep: number;
  update: number;
  upload: number;
}

export interface LockstepPlan {
  counts: LockstepPlanCounts;
  items: LockstepPlanItem[];
  skipped: number;
  skippedEntries: Array<{ path: string; reason: string }>;
  sourceRoot: string;
  totalBytes: number;
  totalFiles: number;
}

export interface LockstepRunSummary {
  action: "plan" | "push" | "prune" | "doctor";
  completedAt: string;
  failed: number;
  message?: string;
  planCounts?: LockstepPlanCounts;
  profileId?: string;
  pushed: number;
  status: "cancelled" | "completed" | "failed";
}

export type LockstepRunEvent =
  | { type: "cancelled" }
  | { type: "complete"; summary: LockstepRunSummary }
  | {
      type: "item-failure";
      action: string;
      current: number;
      error: string;
      path: string;
      total: number;
    }
  | {
      type: "item-success";
      action: string;
      current: number;
      path: string;
      total: number;
    }
  | { type: "scan-progress"; progress: ScanArchiveProgress }
  | { type: "status"; message: string };

export interface LockstepObserver {
  onEvent(event: LockstepRunEvent): void;
}

export interface PlanSyncOptions {
  apiToken?: string;
  apiUrl?: string;
  hashFiles?: boolean;
  remoteSnapshotPath?: string;
  signal?: AbortSignal;
  sourceRoot: string;
}

export interface PushChangesOptions {
  apiToken: string;
  apiUrl: string;
  hashFiles?: boolean;
  maxChanges?: number;
  plan?: LockstepPlan;
  remoteSnapshotPath?: string;
  signal?: AbortSignal;
  sourceRoot: string;
}

export interface PruneDeletedOptions {
  apiToken: string;
  apiUrl: string;
  hashFiles?: boolean;
  maxChanges?: number;
  plan?: LockstepPlan;
  remoteSnapshotPath?: string;
  signal?: AbortSignal;
  sourceRoot: string;
}

export interface DoctorOptions {
  apiToken?: string;
  apiUrl?: string;
  signal?: AbortSignal;
  sourceRoot?: string;
}

export interface DoctorCheck {
  detail?: string;
  label: string;
  ok: boolean;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
}
