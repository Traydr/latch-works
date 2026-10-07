import type {
  DoctorResult,
  LockstepPlan,
  LockstepProfilePublic,
  LockstepSettings,
} from "../../../shared/types";
import type { PruneAvailability } from "../../lib/run-lifecycle";
import type { TransferSpan } from "../../lib/run-metrics";

/** What the current plan has been through since it was made. */
export interface PipelineProgressState {
  pushCompleted: boolean;
  pruneCompleted: boolean;
}

export const initialPipelineProgress: PipelineProgressState = {
  pushCompleted: false,
  pruneCompleted: false,
};

export type Screen = "workspace" | "profile";

/** The operation a run was started for; status messages never change it. */
export type RunKind = "" | "doctor" | "plan" | "prune" | "push";

/** Where one plan item stands in the push or prune that is running or just ended. */
export type ItemRunState =
  | { type: "active" }
  | { type: "done" }
  | { type: "failed"; error: string }
  | { type: "skipped"; reason: string };

export type RunPhase =
  | "idle"
  | "planning"
  | "scanning"
  | "hashing"
  | "items"
  | "done"
  | "cancelled"
  | "error";

export interface RunProgressState {
  phase: RunPhase;
  kind: RunKind;
  action: string;
  itemCurrent: number;
  itemTotal: number;
  scanFilesFound: number;
  scanSkipped: number;
  bytesHashed: number;
  fileSize: number | null;
  scanPath: string | null;
  scanStage: "scanning" | "hashing" | null;
  currentPath: string | null;
  currentAction: string | null;
  failed: number;
  pushed: number;
  skipped: number;
  /** Bytes the queued items carry, and how many of them have been pushed or have failed. */
  bytesTotal: number;
  bytesDone: number;
  bytesFailed: number;
  /** When the work list was queued, after any planning the run did first. */
  queuedAt: number | null;
  /** Each pushed item's bytes over the time it took, for throughput and the chart. */
  spans: TransferSpan[];
  /** When each item failure arrived, for the marks on the throughput chart. */
  failureTimes: number[];
  startedAt: number | null;
  endedAt: number | null;
  summaryMessage: string | null;
}

export const initialProgress: RunProgressState = {
  phase: "idle",
  kind: "",
  action: "",
  itemCurrent: 0,
  itemTotal: 0,
  scanFilesFound: 0,
  scanSkipped: 0,
  bytesHashed: 0,
  fileSize: null,
  scanPath: null,
  scanStage: null,
  currentPath: null,
  currentAction: null,
  failed: 0,
  pushed: 0,
  skipped: 0,
  bytesTotal: 0,
  bytesDone: 0,
  bytesFailed: 0,
  queuedAt: null,
  spans: [],
  failureTimes: [],
  startedAt: null,
  endedAt: null,
  summaryMessage: null,
};

export const emptyProfileForm = {
  apiUrl: "http://localhost:3000",
  /** Edit mode only: forget the saved token instead of keeping or replacing it. */
  clearToken: false,
  name: "",
  sourceRoot: "",
  token: "",
};

export type ProfileFormState = typeof emptyProfileForm;

/** Dashboard / shell: navigation, settings, active profile, session token. */
export interface SessionController {
  screen: Screen;
  setScreen: (screen: Screen) => void;
  settings: LockstepSettings | null;
  activeProfile: LockstepProfilePublic | null;
  error: string | null;
  sessionToken: string;
  setSessionToken: (value: string) => void;
  handleProfileChange: (profileId: string) => Promise<void>;
}

/** Profile setup screen (create or edit) and profile deletion. */
export interface ProfileController {
  profileForm: ProfileFormState;
  setProfileForm: React.Dispatch<React.SetStateAction<ProfileFormState>>;
  /** The saved profile the form edits, or null when it creates a new one. */
  editingProfile: LockstepProfilePublic | null;
  startCreateProfile: () => void;
  startEditProfile: (profileId: string) => void;
  cancelProfileForm: () => void;
  handleSubmitProfile: (event: React.FormEvent) => Promise<void>;
  handleDeleteProfile: (profileId: string) => Promise<void>;
  handlePickFolder: () => Promise<void>;
}

/** The plan under review + doctor result surface. */
export interface PlanController {
  plan: LockstepPlan | null;
  /** When the plan on screen was made. */
  plannedAt: number | null;
  doctorResult: DoctorResult | null;
  dismissDoctorResult: () => void;
  filter: string;
  setFilter: (value: string) => void;
  /** Changed items (no keeps) whose path matches `filter`. */
  filteredItems: LockstepPlan["items"];
  pipelineProgress: PipelineProgressState;
  /** Whether the Prune stage can apply this plan's deletes. */
  pruneAvailability: PruneAvailability;
}

/** Run panel and status bar: progress, logs, and sync actions. */
export interface RunController {
  running: boolean;
  runLabel: string;
  logs: string[];
  runProgress: RunProgressState;
  /** Per-path state for the last push or prune; mutated in place, so read it with `itemStatesVersion`. */
  itemStates: ReadonlyMap<string, ItemRunState>;
  itemStatesVersion: number;
  handleDoctor: () => Promise<void>;
  handlePlan: () => Promise<boolean>;
  handlePush: () => Promise<void>;
  handlePrune: () => Promise<void>;
  handleCancel: () => Promise<void>;
}

/**
 * Screen-scoped Lockstep controller surface.
 * Callers should depend on the slice they need (session | profile | plan | run).
 */
export interface LockstepController {
  session: SessionController;
  profile: ProfileController;
  plan: PlanController;
  run: RunController;
}
