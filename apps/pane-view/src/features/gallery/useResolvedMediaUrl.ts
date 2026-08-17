import { useEffect, useMemo, useReducer } from "react";
import { resolveMediaDeliveryUrl } from "@/features/media/media-delivery-service";
import {
  acquireResolveSlot,
  circuitWaitMs,
  delay,
  isCircuitOpen,
  recordResolveFailure,
  recordResolveSuccess,
} from "./resolve-throttle";

const PENDING_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const;

/**
 * Original delivery is a 60s presigned storage URL (`planSignedOriginalDelivery`),
 * so a cached one is dropped well before it expires. Renditions carry 24h Shutter
 * capabilities and stay cached for the session.
 */
const ORIGINAL_URL_CACHE_TTL_MS = 45_000;

type ResolveInput = {
  mediaId: string;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
};

type ResolveOutcome =
  | { status: "ready"; url: string }
  | { retryAfterMs: number; status: "pending" }
  | { status: "failed" };

type ResolveCacheEntry = {
  inFlight?: Promise<ResolveOutcome>;
  nextRetryAt?: number;
  pendingAttempt: number;
  url?: string;
  urlExpiresAt?: number;
};

function urlExpiresAt(variant: ResolveInput["variant"], now: number): number | undefined {
  return variant === "original" ? now + ORIGINAL_URL_CACHE_TTL_MS : undefined;
}

interface ResolveThrottle {
  acquireResolveSlot(): Promise<() => void>;
  circuitWaitMs(): number;
  isCircuitOpen(): boolean;
  recordResolveFailure(): void;
  recordResolveSuccess(): void;
}

export interface ResolvedMediaUrlCache {
  /**
   * `refresh` discards a cached URL for this input before resolving, for a
   * caller whose `<img>` kept failing on it (expired presigned original,
   * expired Shutter capability). An in-flight resolve is joined as usual.
   */
  resolve(input: ResolveInput, options?: { refresh?: boolean }): Promise<ResolveOutcome>;
}

function resolveCacheKey({ mediaId, size, variant }: ResolveInput): string {
  return `${variant}:${mediaId}:${size ?? "default"}`;
}

function pendingRetryDelayMs(attempt: number, serverRetryAfterMs?: number): number {
  const fallbackDelay = 60_000;
  const baseDelay =
    PENDING_RETRY_DELAYS_MS[Math.min(attempt, PENDING_RETRY_DELAYS_MS.length - 1)] ?? fallbackDelay;
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.max(serverRetryAfterMs ?? 0, Math.round(baseDelay * jitter));
}

/** The server function's call shape, so tests can supply a plain async function. */
export type ResolveMediaDeliveryUrl = (options: {
  data: ResolveInput;
}) => Promise<{ pending: true; retryAfterMs: number } | { pending: false; url: string }>;

export function createResolvedMediaUrlCache({
  resolve = resolveMediaDeliveryUrl,
  throttle = {
    acquireResolveSlot,
    circuitWaitMs,
    isCircuitOpen,
    recordResolveFailure,
    recordResolveSuccess,
  },
}: {
  resolve?: ResolveMediaDeliveryUrl;
  throttle?: ResolveThrottle;
} = {}): ResolvedMediaUrlCache {
  const entries = new Map<string, ResolveCacheEntry>();

  return {
    async resolve(input, options): Promise<ResolveOutcome> {
      const key = resolveCacheKey(input);
      const entry = entries.get(key) ?? { pendingAttempt: 0 };
      entries.set(key, entry);

      if (entry.inFlight) return entry.inFlight;
      const now = Date.now();
      if (options?.refresh || (entry.urlExpiresAt !== undefined && entry.urlExpiresAt <= now)) {
        entry.url = undefined;
        entry.urlExpiresAt = undefined;
        entry.nextRetryAt = undefined;
        entry.pendingAttempt = 0;
      }
      if (entry.url) return { status: "ready", url: entry.url };

      if (entry.nextRetryAt && entry.nextRetryAt > now) {
        return { retryAfterMs: entry.nextRetryAt - now, status: "pending" };
      }

      entry.inFlight = (async () => {
        const breakerWait = throttle.circuitWaitMs();
        if (throttle.isCircuitOpen() && breakerWait > 0) {
          await delay(breakerWait);
        }

        const release = await throttle.acquireResolveSlot();
        try {
          const result = await resolve({ data: input });

          if (result.pending) {
            const retryAfterMs = pendingRetryDelayMs(entry.pendingAttempt, result.retryAfterMs);
            entry.pendingAttempt += 1;
            entry.nextRetryAt = Date.now() + retryAfterMs;
            return { retryAfterMs, status: "pending" };
          }

          throttle.recordResolveSuccess();
          entry.url = result.url;
          entry.urlExpiresAt = urlExpiresAt(input.variant, Date.now());
          entry.nextRetryAt = undefined;
          entry.pendingAttempt = 0;
          return { status: "ready", url: result.url };
        } catch {
          throttle.recordResolveFailure();
          return { status: "failed" };
        } finally {
          release();
          entry.inFlight = undefined;
        }
      })();

      return entry.inFlight;
    },
  };
}

const sharedResolvedMediaUrlCache = createResolvedMediaUrlCache();

interface ResolvedMediaState {
  failed: boolean;
  inputKey: string;
  loading: boolean;
  resolvedUrl?: string;
}

type ResolvedMediaAction =
  | { inputKey: string; type: "failed" }
  | { inputKey: string; type: "pending"; url?: string }
  | { inputKey: string; type: "ready"; url: string }
  | { state: ResolvedMediaState; type: "reset" };

function resolvedMediaReducer(
  state: ResolvedMediaState,
  action: ResolvedMediaAction,
): ResolvedMediaState {
  if (action.type === "reset") {
    return action.state;
  }
  if (action.inputKey !== state.inputKey) {
    return state;
  }
  if (action.type === "ready") {
    return { ...state, failed: false, loading: false, resolvedUrl: action.url };
  }
  if (action.type === "failed") {
    return { ...state, failed: true, loading: false };
  }
  return { ...state, failed: false, loading: !action.url, resolvedUrl: action.url };
}

function createResolvedMediaState(
  inputKey: string,
  mediaId: string | undefined,
  readyUrl: string | undefined,
  fallbackReadyUrl: string | undefined,
): ResolvedMediaState {
  return {
    failed: false,
    inputKey,
    loading: Boolean(mediaId) && !readyUrl && !fallbackReadyUrl,
    resolvedUrl: readyUrl ?? fallbackReadyUrl,
  };
}

export function useResolvedMediaUrl({
  cache = sharedResolvedMediaUrlCache,
  fallbackReadyUrl,
  mediaId,
  readyUrl,
  refreshKey = 0,
  size,
  variant,
}: {
  cache?: ResolvedMediaUrlCache;
  fallbackReadyUrl?: string;
  mediaId: string | undefined;
  readyUrl?: string;
  /** Any value above 0 bypasses the shared URL cache; bump it to re-resolve. */
  refreshKey?: number;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}) {
  const inputKey = `${mediaId ?? "none"}:${variant}:${size ?? "default"}:${refreshKey}:${readyUrl ?? ""}:${fallbackReadyUrl ?? ""}`;
  const initialState = useMemo(
    () => createResolvedMediaState(inputKey, mediaId, readyUrl, fallbackReadyUrl),
    [fallbackReadyUrl, inputKey, mediaId, readyUrl],
  );
  const [storedState, dispatch] = useReducer(resolvedMediaReducer, initialState);
  const state = storedState.inputKey === inputKey ? storedState : initialState;

  // The reducer key and cancellation check both reject stale async results after an input change.
  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect
  useEffect(() => {
    dispatch({ state: initialState, type: "reset" });
    if (!mediaId) {
      return;
    }

    if (readyUrl) {
      return;
    }

    let cancelled = false;
    let refresh = refreshKey > 0;

    void (async () => {
      while (!cancelled) {
        const result = await cache.resolve({ mediaId, size, variant }, { refresh });
        refresh = false;
        if (cancelled) return;

        if (result.status === "ready") {
          dispatch({ inputKey, type: "ready", url: result.url });
          return;
        }

        if (result.status === "failed") {
          dispatch({ inputKey, type: "failed" });
          return;
        }

        dispatch({ inputKey, type: "pending", url: fallbackReadyUrl });

        await delay(result.retryAfterMs);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    cache,
    fallbackReadyUrl,
    initialState,
    inputKey,
    mediaId,
    readyUrl,
    refreshKey,
    size,
    variant,
  ]);

  return {
    failed: state.failed,
    loading: state.loading,
    resolvedUrl: state.resolvedUrl,
  };
}
