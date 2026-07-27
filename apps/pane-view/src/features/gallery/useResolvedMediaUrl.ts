import { useEffect, useState } from "react";
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
};

interface ResolveThrottle {
  acquireResolveSlot(): Promise<() => void>;
  circuitWaitMs(): number;
  isCircuitOpen(): boolean;
  recordResolveFailure(): void;
  recordResolveSuccess(): void;
}

export interface ResolvedMediaUrlCache {
  resolve(input: ResolveInput): Promise<ResolveOutcome>;
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
  resolve?: typeof resolveMediaDeliveryUrl;
  throttle?: ResolveThrottle;
} = {}): ResolvedMediaUrlCache {
  const entries = new Map<string, ResolveCacheEntry>();

  return {
    async resolve(input): Promise<ResolveOutcome> {
      const key = resolveCacheKey(input);
      const entry = entries.get(key) ?? { pendingAttempt: 0 };
      entries.set(key, entry);

      if (entry.url) return { status: "ready", url: entry.url };
      if (entry.inFlight) return entry.inFlight;

      const now = Date.now();
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
  refreshKey?: number;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(readyUrl ?? fallbackReadyUrl);
  const [loading, setLoading] = useState(Boolean(mediaId) && !readyUrl && !fallbackReadyUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!mediaId) {
      setResolvedUrl(undefined);
      setLoading(false);
      setFailed(false);
      return;
    }

    if (readyUrl) {
      setResolvedUrl(readyUrl);
      setLoading(false);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setLoading(!fallbackReadyUrl);
    setFailed(false);
    setResolvedUrl(fallbackReadyUrl);

    void (async () => {
      while (!cancelled) {
        const result = await cache.resolve({ mediaId, size, variant });
        if (cancelled) return;

        if (result.status === "ready") {
          setResolvedUrl(result.url);
          setLoading(false);
          setFailed(false);
          return;
        }

        if (result.status === "failed") {
          setFailed(true);
          setLoading(false);
          return;
        }

        if (fallbackReadyUrl) {
          setResolvedUrl(fallbackReadyUrl);
          setLoading(false);
          setFailed(false);
        }

        await delay(result.retryAfterMs);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cache, fallbackReadyUrl, mediaId, readyUrl, refreshKey, size, variant]);

  return { failed, loading, resolvedUrl };
}
