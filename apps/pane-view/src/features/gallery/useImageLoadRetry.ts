import { useEffect, useMemo, useReducer } from "react";

/**
 * Backoff between `<img>` load attempts. A Shutter image rendition is created
 * on first request (edge miss → Control → imgproxy → S3), so a burst of cold
 * tiles can overrun imgproxy and answer 503 for a while; the schedule spreads
 * the retries out instead of hammering it again at once.
 */
export const IMAGE_LOAD_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000] as const;

/** Total `<img>` loads before the tile gives up: the first plus one per delay. */
export const IMAGE_LOAD_MAX_ATTEMPTS = IMAGE_LOAD_RETRY_DELAYS_MS.length + 1;

/**
 * Failures on the initially resolved URL before the tile asks the server for a
 * fresh one. Cached URLs expire (60s presigned originals, 24h Shutter
 * capabilities) and a browser cannot tell a 403 from a 503, so a stubborn
 * failure is answered with a re-resolve partway through the schedule.
 */
export const IMAGE_LOAD_REFRESH_URL_AFTER_FAILURES = 3;

/**
 * Delay before the next load once `failures` loads have failed. `null` when
 * the schedule is exhausted. Jitter keeps a batch of tiles that failed together
 * from retrying together.
 */
export function imageLoadRetryDelayMs(
  failures: number,
  random: () => number = Math.random,
): number | null {
  const base = IMAGE_LOAD_RETRY_DELAYS_MS[failures - 1];
  if (failures < 1 || base === undefined) {
    return null;
  }
  return Math.round(base * (0.5 + random() * 0.5));
}

export type ImageLoadPhase = "loading" | "waiting" | "failed";

interface ImageLoadRetryState {
  /** Loads that have failed since the last reset. */
  failures: number;
  phase: ImageLoadPhase;
  resetKey: string;
}

type ImageLoadRetryAction =
  | { resetKey: string; type: "error" }
  | { resetKey: string; type: "retry" }
  | { state: ImageLoadRetryState; type: "reset" };

function initialImageLoadRetryState(resetKey: string): ImageLoadRetryState {
  return { failures: 0, phase: "loading", resetKey };
}

function imageLoadRetryReducer(
  state: ImageLoadRetryState,
  action: ImageLoadRetryAction,
): ImageLoadRetryState {
  if (action.type === "reset") {
    return action.state;
  }
  if (action.resetKey !== state.resetKey) {
    return state;
  }
  if (action.type === "error") {
    if (state.phase !== "loading") {
      return state;
    }
    const failures = state.failures + 1;
    return {
      ...state,
      failures,
      phase: failures >= IMAGE_LOAD_MAX_ATTEMPTS ? "failed" : "waiting",
    };
  }
  return state.phase === "waiting" ? { ...state, phase: "loading" } : state;
}

export interface ImageLoadRetry {
  /** Loads that have failed for the current `resetKey`; use as the `<img>` key. */
  failures: number;
  onError: () => void;
  phase: ImageLoadPhase;
  /** True once enough loads failed that the caller should resolve a fresh URL. */
  shouldRefreshUrl: boolean;
}

/**
 * Drives `<img>` retries for one media input. `resetKey` identifies the input
 * (media, variant, size, supplied URL) rather than the resolved URL, so a
 * caller can swap in a freshly resolved URL mid-schedule without restarting
 * the count.
 */
export function useImageLoadRetry(resetKey: string): ImageLoadRetry {
  const initialState = useMemo(() => initialImageLoadRetryState(resetKey), [resetKey]);
  const [storedState, dispatch] = useReducer(imageLoadRetryReducer, initialState);
  const state = storedState.resetKey === resetKey ? storedState : initialState;

  useEffect(() => {
    dispatch({ state: initialState, type: "reset" });
  }, [initialState]);

  const { failures, phase } = state;
  useEffect(() => {
    if (phase !== "waiting") {
      return;
    }
    const delayMs = imageLoadRetryDelayMs(failures);
    if (delayMs === null) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      dispatch({ resetKey, type: "retry" });
    }, delayMs);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [failures, phase, resetKey]);

  return {
    failures,
    onError: () => dispatch({ resetKey, type: "error" }),
    phase,
    shouldRefreshUrl: failures >= IMAGE_LOAD_REFRESH_URL_AFTER_FAILURES,
  };
}
