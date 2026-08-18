import {
  type MediaDeliveryBatchResult,
  resolveMediaDeliveryUrls,
} from "@/features/media/media-delivery-service";
import { GALLERY_THUMBNAIL_SIZE } from "./gallery-thumbnail-size";

export interface GalleryThumbnailRequest {
  mediaId: string;
  size?: number;
}

export interface GalleryThumbnailResolveState {
  urls: Record<string, string>;
}

/** The delivery call the batch makes, so tests can supply a plain async function. */
export type ResolveMediaDeliveryUrls = (options: {
  data: {
    items: { mediaId: string; size: number; variant: "thumbnail" }[];
  };
}) => Promise<{ results: MediaDeliveryBatchResult[] }>;

export interface GalleryThumbnailResolver {
  getNextPendingThumbnailRetryMs(requests: GalleryThumbnailRequest[]): number | null;
  hasEligibleGalleryThumbnailRequests(requests: GalleryThumbnailRequest[]): boolean;
  readCachedGalleryThumbnailState(): GalleryThumbnailResolveState;
  resolveGalleryThumbnailsBatch(
    requests: GalleryThumbnailRequest[],
  ): Promise<GalleryThumbnailResolveState>;
}

interface ThumbnailCacheEntry {
  inFlight: boolean;
  nextRetryAt?: number;
  status: "failed" | "pending" | "ready";
  url?: string;
}

const PENDING_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const;

interface ThumbnailResolverState {
  attempts: Map<string, number>;
  cache: Map<string, ThumbnailCacheEntry>;
  resolveUrls: ResolveMediaDeliveryUrls;
}

function cacheKey(request: GalleryThumbnailRequest): string {
  return `${request.mediaId}:${request.size ?? GALLERY_THUMBNAIL_SIZE}`;
}

function pendingRetryDelayMs(
  state: ThumbnailResolverState,
  key: string,
  serverRetryAfterMs?: number,
): number {
  const attempt = state.attempts.get(key) ?? 0;
  const baseDelay =
    PENDING_RETRY_DELAYS_MS[Math.min(attempt, PENDING_RETRY_DELAYS_MS.length - 1)] ?? 60_000;
  state.attempts.set(key, attempt + 1);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.max(serverRetryAfterMs ?? 0, Math.round(baseDelay * jitter));
}

function applyResult(state: ThumbnailResolverState, result: MediaDeliveryBatchResult): void {
  const key = cacheKey({
    mediaId: result.mediaId,
    size: result.size,
  });

  if (result.status === "ready") {
    if (!result.url) {
      state.cache.set(key, {
        inFlight: false,
        nextRetryAt: Date.now() + pendingRetryDelayMs(state, key),
        status: "pending",
      });
      return;
    }

    state.attempts.delete(key);
    state.cache.set(key, {
      status: "ready",
      url: result.url,
      inFlight: false,
    });
    return;
  }

  if (result.status === "pending") {
    state.cache.set(key, {
      inFlight: false,
      nextRetryAt: Date.now() + pendingRetryDelayMs(state, key, result.retryAfterMs),
      status: "pending",
    });
    return;
  }

  state.attempts.delete(key);
  state.cache.set(key, { inFlight: false, status: "failed" });
}

function readCachedGalleryThumbnailStateFor(
  state: ThumbnailResolverState,
): GalleryThumbnailResolveState {
  const urls: Record<string, string> = {};

  for (const [key, entry] of state.cache) {
    if (entry.status !== "ready") {
      continue;
    }

    const mediaId = key.split(":")[0];
    if (!mediaId) {
      continue;
    }

    if (entry.url) {
      urls[mediaId] = entry.url;
    }
  }

  return { urls };
}

function getNextPendingThumbnailRetryMsFor(
  state: ThumbnailResolverState,
  requests: GalleryThumbnailRequest[],
): number | null {
  const now = Date.now();
  let earliestDelay: number | null = null;

  for (const request of requests) {
    const cached = state.cache.get(cacheKey(request));
    if (cached?.status !== "pending" || cached.inFlight) {
      continue;
    }

    if (!cached.nextRetryAt || cached.nextRetryAt <= now) {
      return 0;
    }

    const delay = cached.nextRetryAt - now;
    earliestDelay = earliestDelay === null ? delay : Math.min(earliestDelay, delay);
  }

  return earliestDelay;
}

function hasEligibleGalleryThumbnailRequestsFor(
  state: ThumbnailResolverState,
  requests: GalleryThumbnailRequest[],
): boolean {
  const now = Date.now();

  return requests.some((request) => {
    const cached = state.cache.get(cacheKey(request));
    return (
      cached?.status !== "ready" &&
      cached?.status !== "failed" &&
      !cached?.inFlight &&
      (!cached?.nextRetryAt || cached.nextRetryAt <= now)
    );
  });
}

async function resolveGalleryThumbnailsBatchFor(
  state: ThumbnailResolverState,
  requests: GalleryThumbnailRequest[],
): Promise<GalleryThumbnailResolveState> {
  const now = Date.now();
  const uniqueRequests = new Map<string, GalleryThumbnailRequest>();

  for (const request of requests) {
    const key = cacheKey(request);
    const cached = state.cache.get(key);
    if (cached?.status === "ready" || cached?.status === "failed" || cached?.inFlight) {
      continue;
    }

    if (cached?.nextRetryAt && cached.nextRetryAt > now) {
      continue;
    }

    uniqueRequests.set(key, request);
  }

  const batch = [...uniqueRequests.entries()].slice(0, 48);
  if (batch.length === 0) {
    return readCachedGalleryThumbnailStateFor(state);
  }

  for (const [key] of batch) {
    state.cache.set(key, { inFlight: true, status: "pending" });
  }

  try {
    const response = await state.resolveUrls({
      data: {
        items: batch.map(([, request]) => ({
          mediaId: request.mediaId,
          size: request.size ?? GALLERY_THUMBNAIL_SIZE,
          variant: "thumbnail" as const,
        })),
      },
    });

    for (const result of response.results) {
      applyResult(state, result);
    }

    const resolvedKeys = new Set(
      response.results.map((result) => cacheKey({ mediaId: result.mediaId, size: result.size })),
    );
    for (const [key] of batch) {
      if (!resolvedKeys.has(key) && state.cache.get(key)?.inFlight) {
        state.cache.set(key, {
          inFlight: false,
          nextRetryAt: Date.now() + pendingRetryDelayMs(state, key),
          status: "pending",
        });
      }
    }
  } catch {
    const retryAt = Date.now() + 30_000;
    for (const [key] of batch) {
      state.cache.set(key, {
        inFlight: false,
        nextRetryAt: retryAt,
        status: "pending",
      });
    }
  }

  return readCachedGalleryThumbnailStateFor(state);
}

export function createThumbnailResolver({
  resolveUrls = resolveMediaDeliveryUrls,
}: {
  resolveUrls?: ResolveMediaDeliveryUrls;
} = {}): GalleryThumbnailResolver {
  const state: ThumbnailResolverState = {
    attempts: new Map(),
    cache: new Map(),
    resolveUrls,
  };

  return {
    getNextPendingThumbnailRetryMs: (requests: GalleryThumbnailRequest[]) =>
      getNextPendingThumbnailRetryMsFor(state, requests),
    hasEligibleGalleryThumbnailRequests: (requests: GalleryThumbnailRequest[]) =>
      hasEligibleGalleryThumbnailRequestsFor(state, requests),
    readCachedGalleryThumbnailState: () => readCachedGalleryThumbnailStateFor(state),
    resolveGalleryThumbnailsBatch: (requests: GalleryThumbnailRequest[]) =>
      resolveGalleryThumbnailsBatchFor(state, requests),
  };
}

export const sharedThumbnailResolver = createThumbnailResolver();

export const {
  getNextPendingThumbnailRetryMs,
  hasEligibleGalleryThumbnailRequests,
  readCachedGalleryThumbnailState,
  resolveGalleryThumbnailsBatch,
} = sharedThumbnailResolver;
