import {
  GATHER_RUN_STATE_KEY,
  isTerminalGatherRunPhase,
  normalizeGatherRunState,
  type GatherRunState
} from "./gather-run";

export async function loadGatherRun(): Promise<GatherRunState | null> {
  const stored = await chrome.storage.local.get(GATHER_RUN_STATE_KEY);
  return normalizeGatherRunState(stored[GATHER_RUN_STATE_KEY]);
}

export async function saveGatherRun(run: GatherRunState): Promise<void> {
  await chrome.storage.local.set({ [GATHER_RUN_STATE_KEY]: run });
}

async function hasActiveOffscreenGatherDocument(): Promise<boolean> {
  try {
    const offscreenUrl = chrome.runtime.getURL("offscreen/offscreen.html");
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

export async function markInterruptedGatherRun(): Promise<GatherRunState | null> {
  const run = await loadGatherRun();
  if (!run || isTerminalGatherRunPhase(run.phase) || run.phase === "permission-required") {
    return run;
  }

  // Offscreen can outlive a suspended service worker. Leave the run alone while it is still active.
  if (await hasActiveOffscreenGatherDocument()) {
    return run;
  }

  const interrupted: GatherRunState = {
    ...run,
    phase: "interrupted",
    updatedAt: Date.now(),
    error: "The browser stopped the previous Gather Run before it reported completion.",
    progress: {
      ...run.progress,
      message: "Gather Run interrupted. Start it again to retry safely."
    }
  };
  await saveGatherRun(interrupted);
  return interrupted;
}

let interruptRecovery: Promise<GatherRunState | null> | null = null;

/** Deduplicated recovery for extension install and browser startup. */
export function recoverInterruptedGatherRun(): Promise<GatherRunState | null> {
  if (!interruptRecovery) {
    interruptRecovery = markInterruptedGatherRun().finally(() => {
      interruptRecovery = null;
    });
  }
  return interruptRecovery;
}
