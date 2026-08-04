import type {
  DoctorResult,
  LockstepPlan,
  LockstepProfilePublic,
  LockstepSettings,
} from "../../../shared/types";

export interface PipelineProgressState {
  reviewed: boolean;
  pushCompleted: boolean;
  pruneCompleted: boolean;
}

export type Screen = "dashboard" | "plan" | "profile" | "run";

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
  startedAt: number | null;
  endedAt: number | null;
  summaryMessage: string | null;
}

export const initialProgress: RunProgressState = {
  phase: "idle",
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
  startedAt: null,
  endedAt: null,
  summaryMessage: null,
};

export const emptyProfileForm = {
  apiUrl: "http://localhost:3000",
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

/** Profile setup screen. */
export interface ProfileController {
  profileForm: ProfileFormState;
  setProfileForm: React.Dispatch<React.SetStateAction<ProfileFormState>>;
  handleCreateProfile: (event: React.FormEvent) => Promise<void>;
  handlePickFolder: () => Promise<void>;
}

/** Plan review screen + doctor result surface. */
export interface PlanController {
  plan: LockstepPlan | null;
  doctorResult: DoctorResult | null;
  filter: string;
  setFilter: (value: string) => void;
  filteredItems: Array<{ action: string; path: string }>;
  pipelineProgress: PipelineProgressState;
  markReviewVisited: () => void;
}

/** Run / command dock: progress, logs, and sync actions. */
export interface RunController {
  running: boolean;
  runLabel: string;
  logs: string[];
  runProgress: RunProgressState;
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
