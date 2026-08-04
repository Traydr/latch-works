import { AppLayout } from "../renderer/components/AppLayout";
import type {
  LockstepController,
  RunProgressState,
  Screen,
} from "../renderer/hooks/useLockstepController";
import { showcasePlan, showcaseSettings } from "./fixtures";

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
const noopPlan = async () => false;

function createController(screen: Screen): LockstepController {
  const running = screen === "run";
  const runProgress = running ? pushProgress() : idleProgress;

  return {
    session: {
      screen,
      setScreen: noop,
      settings: showcaseSettings,
      activeProfile: showcaseSettings.profiles[0] ?? null,
      error: null,
      sessionToken: "",
      setSessionToken: noop,
      handleProfileChange: noopAsync,
    },
    profile: {
      profileForm: {
        apiUrl: "http://localhost:3000",
        name: "",
        sourceRoot: "",
        token: "",
      },
      setProfileForm: noop,
      handleCreateProfile: noopAsync,
      handlePickFolder: noopAsync,
    },
    plan: {
      plan: showcasePlan,
      doctorResult: null,
      filter: "",
      setFilter: noop,
      filteredItems: showcasePlan.items.filter((item) => item.action !== "keep"),
      pipelineProgress: {
        reviewed: screen === "plan",
        pushCompleted: false,
        pruneCompleted: false,
      },
      markReviewVisited: noop,
    },
    run: {
      running,
      runLabel: running ? "[4/8] update sfw/photos/sample-03.jpg" : "",
      logs: running ? pushLogs : [],
      runProgress,
      handleDoctor: noopAsync,
      handlePlan: noopPlan,
      handlePush: noopAsync,
      handlePrune: noopAsync,
      handleCancel: noopAsync,
    },
  };
}

export function ShowcasePlanScreen() {
  return <AppLayout ctrl={createController("plan")} />;
}

export function ShowcasePushScreen() {
  return <AppLayout ctrl={createController("run")} />;
}
