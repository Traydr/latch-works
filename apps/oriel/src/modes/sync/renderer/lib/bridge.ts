import type { LockstepApi } from "../../shared/types";

/**
 * The preload bridge is absent whenever the renderer loads outside Electron or the preload script
 * failed; the entry point renders `BridgeUnavailable` in that case, so every controller call site
 * runs with the bridge present.
 */
export function requireLockstepApi(): LockstepApi {
  const api = window.lockstep;

  if (!api) {
    throw new Error("Sync's desktop bridge is unavailable.");
  }

  return api;
}
