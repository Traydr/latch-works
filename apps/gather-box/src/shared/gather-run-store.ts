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

export async function markInterruptedGatherRun(): Promise<GatherRunState | null> {
  const run = await loadGatherRun();
  if (!run || isTerminalGatherRunPhase(run.phase) || run.phase === "permission-required") {
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
