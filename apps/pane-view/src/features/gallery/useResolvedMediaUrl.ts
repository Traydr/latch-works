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

const MAX_THUMBNAIL_PENDING_POLLS_PER_MOUNT = 3;
const MAX_PREVIEW_PENDING_POLLS_PER_MOUNT = 30;
const PENDING_RETRY_DELAYS_MS = [15_000, 45_000, 120_000, 300_000] as const;

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

const resolveCache = new Map<string, ResolveCacheEntry>();

function resolveCacheKey({ mediaId, size, variant }: ResolveInput): string {
  return `${variant}:${mediaId}:${size ?? "default"}`;
}

function maxPendingPollsForVariant(variant: ResolveInput["variant"]): number {
  return variant === "preview"
    ? MAX_PREVIEW_PENDING_POLLS_PER_MOUNT
    : MAX_THUMBNAIL_PENDING_POLLS_PER_MOUNT;
}

function pendingRetryDelayMs(attempt: number): number {
  const fallbackDelay = 300_000;
  const baseDelay =
    PENDING_RETRY_DELAYS_MS[Math.min(attempt, PENDING_RETRY_DELAYS_MS.length - 1)] ?? fallbackDelay;
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(baseDelay * jitter);
}

async function resolveSharedMediaUrl(input: ResolveInput): Promise<ResolveOutcome> {
  const key = resolveCacheKey(input);
  const entry = resolveCache.get(key) ?? { pendingAttempt: 0 };
  resolveCache.set(key, entry);

  if (entry.url) {
    return { status: "ready", url: entry.url };
  }

  if (entry.inFlight) {
    return entry.inFlight;
  }

  const now = Date.now();
  if (entry.nextRetryAt && entry.nextRetryAt > now) {
    return { retryAfterMs: entry.nextRetryAt - now, status: "pending" };
  }

  entry.inFlight = (async () => {
    const breakerWait = circuitWaitMs();
    if (isCircuitOpen() && breakerWait > 0) {
      await delay(breakerWait);
    }

    const release = await acquireResolveSlot();
    try {
      const result = await resolveMediaDeliveryUrl({
        data: input,
      });

      if (result.pending) {
        const retryAfterMs = pendingRetryDelayMs(entry.pendingAttempt);
        entry.pendingAttempt += 1;
        entry.nextRetryAt = Date.now() + retryAfterMs;
        return { retryAfterMs, status: "pending" };
      }

      recordResolveSuccess();
      entry.url = result.url;
      entry.nextRetryAt = undefined;
      entry.pendingAttempt = 0;
      return { status: "ready", url: result.url };
    } catch {
      recordResolveFailure();
      return { status: "failed" };
    } finally {
      release();
      entry.inFlight = undefined;
    }
  })();

  return entry.inFlight;
}

export function useResolvedMediaUrl({
  fallbackReadyUrl,
  mediaId,
  readyUrl,
  refreshKey = 0,
  size,
  variant,
}: {
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
      for (let attempt = 0; attempt < maxPendingPollsForVariant(variant); attempt += 1) {
        if (cancelled) {
          return;
        }

        const result = await resolveSharedMediaUrl({ mediaId, size, variant });

        if (cancelled) {
          return;
        }

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

      if (!cancelled) {
        if (fallbackReadyUrl) {
          setResolvedUrl(fallbackReadyUrl);
          setLoading(false);
          setFailed(false);
        } else {
          setFailed(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fallbackReadyUrl, mediaId, readyUrl, refreshKey, size, variant]);

  return { failed, loading, resolvedUrl };
}

export function __resetResolvedMediaUrlCacheForTests(): void {
  resolveCache.clear();
}
