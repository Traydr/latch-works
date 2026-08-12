import {
  GATHER_RUN_STATE_KEY,
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
