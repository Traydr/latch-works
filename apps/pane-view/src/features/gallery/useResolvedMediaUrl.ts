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
  | { deliveryToken?: string; status: "ready"; url?: string }
  | { retryAfterMs: number; status: "pending" }
  | { status: "failed" };

type ResolveCacheEntry = {
  deliveryToken?: string;
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

  if (entry.url || entry.deliveryToken) {
    return { deliveryToken: entry.deliveryToken, status: "ready", url: entry.url };
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
      entry.deliveryToken = result.deliveryToken;
      entry.nextRetryAt = undefined;
      entry.pendingAttempt = 0;
      return { deliveryToken: result.deliveryToken, status: "ready", url: result.url };
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
  deliveryToken: readyDeliveryToken,
  fallbackReadyUrl,
  mediaId,
  readyUrl,
  refreshKey = 0,
  size,
  variant,
}: {
  deliveryToken?: string;
  fallbackReadyUrl?: string;
  mediaId: string | undefined;
  readyUrl?: string;
  refreshKey?: number;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}) {
  const [resolvedDeliveryToken, setResolvedDeliveryToken] = useState<string | undefined>(
    readyDeliveryToken,
  );
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(readyUrl ?? fallbackReadyUrl);
  const [loading, setLoading] = useState(
    Boolean(mediaId) && !readyUrl && !fallbackReadyUrl && !readyDeliveryToken,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!mediaId) {
      setResolvedDeliveryToken(undefined);
      setResolvedUrl(undefined);
      setLoading(false);
      setFailed(false);
      return;
    }

    if (readyDeliveryToken) {
      setResolvedDeliveryToken(readyDeliveryToken);
      setResolvedUrl(readyUrl);
      setLoading(false);
      setFailed(false);
      return;
    }

    if (readyUrl) {
      setResolvedUrl(readyUrl);
      setResolvedDeliveryToken(undefined);
      setLoading(false);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setLoading(!fallbackReadyUrl);
    setFailed(false);
    setResolvedUrl(fallbackReadyUrl);
    setResolvedDeliveryToken(undefined);

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
          setResolvedDeliveryToken(result.deliveryToken);
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
  }, [fallbackReadyUrl, mediaId, readyDeliveryToken, readyUrl, refreshKey, size, variant]);

  return { deliveryToken: resolvedDeliveryToken, failed, loading, resolvedUrl };
}

export function __resetResolvedMediaUrlCacheForTests(): void {
  resolveCache.clear();
}
