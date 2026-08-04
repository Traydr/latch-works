import { useEffect, useMemo, useRef, useState } from "react";

import { AppLayout } from "../renderer/components/AppLayout";
import type {
  LockstepController,
  RunProgressState,
  Screen,
} from "../renderer/hooks/useLockstepController";
import { showcasePlan, showcaseSettings } from "./fixtures";

const noop = () => undefined;
const noopAsync = async () => undefined;
const noopPlan = async () => false;

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

function createBaseController(
  screen: Screen,
  runProgress: RunProgressState,
  running: boolean,
  pipelineProgress: { reviewed: boolean; pushCompleted: boolean; pruneCompleted: boolean },
  overrides: {
    session?: Partial<LockstepController["session"]>;
    profile?: Partial<LockstepController["profile"]>;
    plan?: Partial<LockstepController["plan"]>;
    run?: Partial<LockstepController["run"]>;
  } = {},
): LockstepController {
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
      ...overrides.session,
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
      ...overrides.profile,
    },
    plan: {
      plan: showcasePlan,
      doctorResult: null,
      filter: "",
      setFilter: noop,
      filteredItems: showcasePlan.items.filter((item) => item.action !== "keep"),
      pipelineProgress,
      markReviewVisited: noop,
      ...overrides.plan,
    },
    run: {
      running,
      runLabel: runProgress.currentPath ?? "",
      logs: [],
      runProgress,
      handleDoctor: noopAsync,
      handlePlan: noopPlan,
      handlePush: noopAsync,
      handlePrune: noopAsync,
      handleCancel: noopAsync,
      ...overrides.run,
    },
  };
}

/**
 * Simulates push upload after the internal plan phase finished (~1m 6s ago).
 * Elapsed time should keep ticking while items upload (255/271 → 271/271).
 */
export function ShowcasePushTimerDemo() {
  const startedAtRef = useRef(Date.now() - 66_000);
  const itemCurrentRef = useRef(240);
  const [running, setRunning] = useState(true);
  const [itemCurrent, setItemCurrent] = useState(240);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!running) {
      return;
    }

    const id = setInterval(() => {
      const nextItemCurrent = Math.min(itemCurrentRef.current + 1, 271);
      itemCurrentRef.current = nextItemCurrent;
      setItemCurrent(nextItemCurrent);

      if (nextItemCurrent === 271) {
        setRunning(false);
        setEndedAt(Date.now());
      }
    }, 1200);

    return () => clearInterval(id);
  }, [running]);

  const runProgress = useMemo(
    (): RunProgressState => ({
      ...idleProgress,
      action: "push",
      bytesHashed: 65_536,
      currentAction: "upload",
      currentPath: "nsfw/twitter/whoami_419/HJ_jcXLbIAA_K2I.jpeg",
      endedAt,
      itemCurrent,
      itemTotal: 271,
      phase: running ? "items" : "done",
      pushed: itemCurrent,
      scanFilesFound: 17_881,
      scanSkipped: 0,
      startedAt: startedAtRef.current,
    }),
    [endedAt, itemCurrent, running],
  );

  return (
    <AppLayout
      ctrl={createBaseController("dashboard", runProgress, running, {
        reviewed: true,
        pushCompleted: !running,
        pruneCompleted: false,
      })}
    />
  );
}

/** Click Review / Push / Prune pipeline stages to see them turn green. */
export function ShowcasePipelineStepsDemo() {
  const [reviewed, setReviewed] = useState(false);
  const [pushCompleted, setPushCompleted] = useState(false);
  const [pruneCompleted, setPruneCompleted] = useState(false);
  const [screen, setScreen] = useState<Screen>("dashboard");

  const ctrl = useMemo(
    (): LockstepController =>
      createBaseController(
        "dashboard",
        idleProgress,
        false,
        {
          reviewed,
          pushCompleted,
          pruneCompleted,
        },
        {
          session: {
            screen,
            setScreen: (next) => {
              if (next === "plan") {
                setReviewed(true);
              }
              setScreen(next);
            },
          },
          plan: {
            markReviewVisited: () => setReviewed(true),
          },
          run: {
            handlePush: async () => setPushCompleted(true),
            handlePrune: async () => setPruneCompleted(true),
          },
        },
      ),
    [pruneCompleted, pushCompleted, reviewed, screen],
  );

  return <AppLayout ctrl={ctrl} />;
}
