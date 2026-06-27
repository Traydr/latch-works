import { AppLayout } from "../renderer/components/AppLayout";
import type {
  LockstepController,
  RunProgressState,
  Screen,
} from "../renderer/hooks/useLockstepController";
import type { LockstepPlan, LockstepPlanItem, LockstepSettings } from "../shared/types";

export const showcaseSettings: LockstepSettings = {
  activeProfileId: "showcase-profile",
  profiles: [
    {
      apiUrl: "https://archive.example.com",
      id: "showcase-profile",
      lastRun: {
        action: "push",
        completedAt: "2026-06-27T00:00:00.000Z",
        failed: 0,
        pushed: 18,
        status: "completed",
      },
      name: "Main archive",
      sourceRoot: "/Volumes/Media/archive",
      tokenConfigured: true,
      tokenInSession: false,
      tokenUnreadable: false,
    },
  ],
};

export const showcasePlan: LockstepPlan = {
  counts: {
    delete: 2,
    keep: 1842,
    update: 5,
    upload: 12,
  },
  items: showcasePlanItems(),
  skipped: 3,
  skippedEntries: [{ path: "sfw/.DS_Store", reason: "not media" }],
  sourceRoot: "/Volumes/Media/archive",
  totalBytes: 1_842_000_000,
  totalFiles: 1866,
};

function showcasePlanItems(): LockstepPlanItem[] {
  return [
    { action: "upload", path: "sfw/photos/sample-14.jpg" },
    { action: "upload", path: "sfw/photos/sample-15.jpg" },
    { action: "upload", path: "sfw/comics/chapter-01/001.webp" },
    { action: "update", path: "sfw/photos/sample-03.jpg" },
    { action: "update", path: "sfw/stories/author-long_title.pdf" },
    { action: "delete", path: "sfw/photos/retired/sample-old.jpg" },
    { action: "delete", path: "sfw/comics/dropped-series/page-04.webp" },
  ];
}

const pushLogs = [
  "Creating sync run...",
  "Pushing 8 upload/update change(s).",
  "[1/8] upload sfw/photos/sample-14.jpg",
  "[2/8] upload sfw/photos/sample-15.jpg",
  "[3/8] upload sfw/comics/chapter-01/001.webp",
  "[4/8] update sfw/photos/sample-03.jpg",
  "Hashing sfw/stories/author-long_title.pdf (847 files)",
];

const idleProgress: RunProgressState = {
  action: "",
  bytesHashed: 0,
  currentAction: null,
  currentPath: null,
  endedAt: null,
  failed: 0,
  fileSize: null,
  itemCurrent: 0,
  itemTotal: 0,
  phase: "idle",
  pushed: 0,
  scanFilesFound: 0,
  scanPath: null,
  scanSkipped: 0,
  scanStage: null,
  startedAt: null,
  summaryMessage: null,
};

function pushProgress(): RunProgressState {
  return {
    ...idleProgress,
    action: "push",
    bytesHashed: 684_000_000,
    currentAction: "update",
    currentPath: "sfw/photos/sample-03.jpg",
    itemCurrent: 4,
    itemTotal: 8,
    phase: "items",
    pushed: 3,
    scanFilesFound: 1866,
    scanSkipped: 3,
    startedAt: Date.now() - 18_000,
  };
}

const noop = () => undefined;
const noopAsync = async () => undefined;

function createController(screen: Screen): LockstepController {
  const running = screen === "run";
  const runProgress = running ? pushProgress() : idleProgress;

  return {
    activeProfile: showcaseSettings.profiles[0] ?? null,
    doctorResult: null,
    error: null,
    filter: "",
    filteredItems: showcasePlan.items.filter((item) => item.action !== "keep"),
    handleCancel: noopAsync,
    handleCreateProfile: noopAsync,
    handleDoctor: noopAsync,
    handlePickFolder: noopAsync,
    handlePlan: noopAsync,
    handleProfileChange: noopAsync,
    handlePrune: noopAsync,
    handlePush: noopAsync,
    logs: running ? pushLogs : [],
    plan: showcasePlan,
    profileForm: {
      apiUrl: "http://localhost:3000",
      name: "",
      sourceRoot: "",
      token: "",
    },
    runLabel: running ? "[4/8] update sfw/photos/sample-03.jpg" : "",
    runProgress,
    running,
    screen,
    sessionToken: "",
    setFilter: noop,
    setProfileForm: noop,
    setScreen: noop,
    setSessionToken: noop,
    settings: showcaseSettings,
  };
}

export function ShowcasePlanScreen() {
  return <AppLayout ctrl={createController("plan")} />;
}

export function ShowcasePushScreen() {
  return <AppLayout ctrl={createController("run")} />;
}
