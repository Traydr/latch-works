import type { SyncRunStatus } from "@latch-works/sync-protocol";
import type { ScanArchiveProgress, SkippedArchiveEntry } from "./scan.js";
import type { SyncPlan, SyncPlanAction } from "./sync-plan.js";

export interface LockstepPlan extends SyncPlan {
  skippedEntries: SkippedArchiveEntry[];
  sourceRoot: string;
  totalBytes: number;
  totalFiles: number;
}

/** How a run ended, for the command that started it. */
export interface RunSummary {
  action: "doctor" | "prune" | "push";
  /** Changes applied: items pushed, or remote entries deleted. */
  applied: number;
  failed: number;
  message?: string;
  /** Prune only: planned deletes left alone because the file is back in the source folder. */
  skipped: number;
  status: SyncRunStatus;
}

/** What one item of a push or prune is doing while it runs. */
export type PushStage = "deleting" | "hashing" | "registering" | "uploading";

/** One item's place in its run's work list. */
interface RunItem {
  action: SyncPlanAction;
  current: number;
  path: string;
  total: number;
}

export type LockstepRunEvent =
  | ({ type: "item-failure"; error: string } & RunItem)
  | ({ type: "item-skipped"; reason: string } & RunItem)
  | ({ type: "item-success" } & RunItem)
  | ({ type: "item-stage"; bytes?: { done: number; total: number }; stage: PushStage } & RunItem)
  | { type: "scan-progress"; progress: ScanArchiveProgress }
  /** Progress the next status replaces. */
  | { type: "status"; message: string }
  /** Something the user has to see after the run, such as a sync run left unfinalized. */
  | { type: "warning"; message: string };

export interface LockstepObserver {
  onEvent(event: LockstepRunEvent): void;
}

type HashMode = "all" | "none" | "remote-aware";

/** What a plan compares the local archive against. */
export type SnapshotSource =
  | { kind: "file"; path: string }
  | { apiToken: string; apiUrl: string; kind: "live" }
  | { kind: "none" };

/** Where a run reaches Pane View's sync API. */
export interface PaneViewApi {
  apiToken: string;
  apiUrl: string;
}

export interface PlanSyncOptions {
  hashCacheRoot?: string;
  hashMode: HashMode;
  remote: SnapshotSource;
  signal?: AbortSignal;
  sourceRoot: string;
}

export interface PushChangesOptions extends PaneViewApi {
  hashCacheRoot?: string;
  maxChanges?: number;
  /** The plan the user reviewed; push uploads and updates its items and never plans again. */
  plan: LockstepPlan;
  signal?: AbortSignal;
  uploadConcurrency?: number;
}

export interface PruneDeletedOptions extends PaneViewApi {
  /** Applies at most this many of the plan's deletes, in plan order. */
  maxChanges?: number;
  /**
   * The plan the user reviewed. Prune applies its delete entries and nothing else; it never plans
   * again. Each delete is re-checked against `plan.sourceRoot` first and skipped when the file is
   * back in the source folder.
   */
  plan: LockstepPlan;
  signal?: AbortSignal;
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
  summary: RunSummary;
}
