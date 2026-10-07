import { useEffect, useState } from "react";

import { AppLayout } from "../renderer/components/AppLayout";
import {
  emptyProfileForm,
  initialPipelineProgress,
  initialProgress,
} from "../renderer/hooks/controller/types";
import type {
  ItemRunState,
  LockstepController,
  PipelineProgressState,
  RunProgressState,
} from "../renderer/hooks/useLockstepController";
import { pruneAvailability } from "../renderer/lib/run-lifecycle";
import type { TransferSpan } from "../renderer/lib/run-metrics";
import { showcasePlan, showcaseSettings } from "./fixtures";

const noop = () => undefined;

const noopAsync = async () => undefined;

const noopPlan = async () => false;

/** The plan's uploads and updates, in the order a push works through them. */
const pushQueue = showcasePlan.items.filter(
  (item) => item.action === "upload" || item.action === "update",
);

const pushBytes = pushQueue.reduce((sum, item) => sum + (item.size ?? 0), 0);

const FAILED_PATH = "sfw/photos/2026-09-trip/IMG_0412.heic";

const FAILED_ERROR = "413 Payload Too Large · server limit is 4 MB";

interface ScreenState {
  running: boolean;
  progress: RunProgressState;
  itemStates: ReadonlyMap<string, ItemRunState>;
  pipelineProgress: PipelineProgressState;
}

function createController({
  running,
  progress,
  itemStates,
  pipelineProgress,
}: ScreenState): LockstepController {
  return {
    session: {
      screen: "workspace",
      setScreen: noop,
      settings: showcaseSettings,
      activeProfile: showcaseSettings.profiles[0] ?? null,
      error: null,
      sessionToken: "",
      setSessionToken: noop,
      handleProfileChange: noopAsync,
    },
    profile: {
      profileForm: emptyProfileForm,
      setProfileForm: noop,
      editingProfile: null,
      startCreateProfile: noop,
      startEditProfile: noop,
      cancelProfileForm: noop,
      handleSubmitProfile: noopAsync,
      handleDeleteProfile: noopAsync,
      handlePickFolder: noopAsync,
    },
    plan: {
      plan: showcasePlan,
      plannedAt: Date.now() - 4 * 60_000,
      doctorResult: null,
      dismissDoctorResult: noop,
      filter: "",
      setFilter: noop,
      filteredItems: showcasePlan.items.filter((item) => item.action !== "keep"),
      pipelineProgress,
      pruneAvailability: pruneAvailability({
        plan: showcasePlan,
        prunedPlanId: null,
        pushCompleted: pipelineProgress.pushCompleted,
      }),
    },
    run: {
      running,
      runLabel: running ? `[${progress.pushed + 1}/${pushQueue.length}] uploading` : "",
      logs: [],
      runProgress: progress,
      itemStates,
      itemStatesVersion: itemStates.size,
      handleDoctor: noopAsync,
      handlePlan: noopPlan,
      handlePush: noopAsync,
      handlePrune: noopAsync,
      handleCancel: noopAsync,
    },
  };
}

/**
 * A push `processed` items in, started `elapsedMs` ago at about 9 MB/s, with the trip photo
 * failing on the way.
 */
function pushState(processed: number, elapsedMs: number, now: number): ScreenState {
  const startedAt = now - elapsedMs;
  const queuedAt = startedAt + 3000;
  const itemStates = new Map<string, ItemRunState>();
  const spans: TransferSpan[] = [];
  const failureTimes: number[] = [];
  const queuedFor = Math.max(now - queuedAt, 1);
  let bytesDone = 0;
  let bytesFailed = 0;
  let pushed = 0;
  let failed = 0;

  for (const [index, item] of pushQueue.entries()) {
    const at = queuedAt + (queuedFor * (index + 1)) / Math.max(processed, 1);

    if (index < processed) {
      if (item.path === FAILED_PATH) {
        itemStates.set(item.path, { type: "failed", error: FAILED_ERROR });
        bytesFailed += item.size ?? 0;
        failed += 1;
        failureTimes.push(at);
      } else {
        itemStates.set(item.path, { type: "done" });
        bytesDone += item.size ?? 0;
        pushed += 1;
        // Three uploads run at once, so each item takes about three slots to finish.
        const from = Math.max(queuedAt, at - (3 * queuedFor) / Math.max(processed, 1));
        spans.push({ from, to: at, bytes: item.size ?? 0 });
      }
    } else if (index < processed + 3) {
      itemStates.set(item.path, { type: "active" });
    }
  }

  const finished = processed >= pushQueue.length;

  return {
    running: !finished,
    itemStates,
    pipelineProgress: { ...initialPipelineProgress, pushCompleted: finished && failed === 0 },
    progress: {
      ...initialProgress,
      kind: "push",
      action: "push",
      phase: finished ? "done" : "items",
      itemTotal: pushQueue.length,
      pushed,
      failed,
      bytesTotal: pushBytes,
      bytesDone,
      bytesFailed,
      queuedAt,
      spans,
      failureTimes,
      startedAt,
      endedAt: finished ? now : null,
      scanFilesFound: showcasePlan.totalFiles,
    },
  };
}

const idleState: ScreenState = {
  running: false,
  progress: initialProgress,
  itemStates: new Map(),
  pipelineProgress: initialPipelineProgress,
};

export function ShowcasePlanScreen() {
  return <AppLayout ctrl={createController(idleState)} />;
}

export function ShowcasePushScreen() {
  return <AppLayout ctrl={createController(pushState(9, 41_000, Date.now()))} />;
}

/** A push that finished cleanly: Done closes the panel, Prune is the next step. */
export function ShowcasePushDoneScreen() {
  const state = pushState(pushQueue.length, 79_000, Date.now());
  // The clean finish drops the failed item so Prune unlocks.
  state.itemStates = new Map(
    [...state.itemStates].map(([path]) => [path, { type: "done" } satisfies ItemRunState]),
  );
  state.progress = {
    ...state.progress,
    pushed: pushQueue.length,
    failed: 0,
    bytesDone: pushBytes,
    bytesFailed: 0,
    failureTimes: [],
  };
  state.pipelineProgress = { ...initialPipelineProgress, pushCompleted: true };

  return <AppLayout ctrl={createController(state)} />;
}

/** Plays a push through so the progress, ETA, and throughput chart can be watched live. */
export function ShowcaseLivePushScreen() {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);

    return () => clearInterval(id);
  }, []);

  const elapsed = now - startedAt;
  const processed = Math.min(pushQueue.length, Math.floor(Math.max(0, elapsed - 3000) / 1800));

  return <AppLayout ctrl={createController(pushState(processed, elapsed, now))} />;
}
