import { useSyncExternalStore } from "react";

/**
 * The playhead in seconds. It changes on every `timeupdate` and scrub move, so
 * it lives outside React state: only the capsule's clock and seek bar
 * subscribe, and the rest of the viewer does not re-render with it.
 */
export interface PlaybackPosition {
  get: () => number;
  set: (seconds: number) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPlaybackPosition(): PlaybackPosition {
  let seconds = 0;
  const listeners = new Set<() => void>();

  return {
    get: () => seconds,
    set: (next) => {
      if (next === seconds) return;
      seconds = next;

      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}

export function usePlaybackPosition(position: PlaybackPosition): number {
  return useSyncExternalStore(position.subscribe, position.get, position.get);
}
