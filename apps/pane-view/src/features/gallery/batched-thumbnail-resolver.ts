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
  readCachedGalleryThumbnailState(
    requests: GalleryThumbnailRequest[],
  ): GalleryThumbnailResolveState;
  resolveGalleryThumbnailsBatch(
    requests: GalleryThumbnailRequest[],
  ): Promise<GalleryThumbnailResolveState>;
}

interface ThumbnailCacheEntry {
  /** Settles when the batch fetching this row completes; absent otherwise. */
  batch?: Promise<GalleryThumbnailResolveState>;
  inFlight: boolean;
  nextRetryAt?: number;
  status: "failed" | "pending" | "ready";
  url?: string;
}

const PENDING_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const;

/**
 * Most settled rows the cache keeps, oldest use evicted first. A grid window
 * is at most about a hundred rows, so this spans many windows of scrolling
 * back. Rows still in flight don't count and are never evicted: dropping one
 * would re-request it before its batch settles. The batches running at once
 * bound them.
 */
const THUMBNAIL_CACHE_LIMIT = 1_000;

interface ThumbnailResolverState {
  attempts: Map<string, number>;
  cache: Map<string, ThumbnailCacheEntry>;
  /** How many cache rows are in flight, so eviction counts settled rows alone. */
  inFlightCount: number;
  resolveUrls: ResolveMediaDeliveryUrls;
}

function cacheKey(request: GalleryThumbnailRequest): string {
  return `${request.mediaId}:${request.size ?? GALLERY_THUMBNAIL_SIZE}`;
}

/** Stores a row as the most recently used, then evicts the least recently used past the limit. */
function setCacheEntry(
  state: ThumbnailResolverState,
  key: string,
  entry: ThumbnailCacheEntry,
): void {
  const previous = state.cache.get(key);

  state.inFlightCount += (entry.inFlight ? 1 : 0) - (previous?.inFlight ? 1 : 0);
  state.cache.delete(key);
  state.cache.set(key, entry);

  for (const [candidateKey, candidate] of state.cache) {
    if (state.cache.size - state.inFlightCount <= THUMBNAIL_CACHE_LIMIT) {
      break;
    }

    if (!candidate.inFlight) {
      state.cache.delete(candidateKey);
      state.attempts.delete(candidateKey);
    }
  }
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
      setCacheEntry(state, key, {
        inFlight: false,
        nextRetryAt: Date.now() + pendingRetryDelayMs(state, key),
        status: "pending",
      });

      return;
    }

    state.attempts.delete(key);
    setCacheEntry(state, key, {
      status: "ready",
      url: result.url,
      inFlight: false,
    });

    return;
  }

  if (result.status === "pending") {
    setCacheEntry(state, key, {
      inFlight: false,
      nextRetryAt: Date.now() + pendingRetryDelayMs(state, key, result.retryAfterMs),
      status: "pending",
    });

    return;
  }

  state.attempts.delete(key);
  setCacheEntry(state, key, { inFlight: false, status: "failed" });
}

function readCachedGalleryThumbnailStateFor(
  state: ThumbnailResolverState,
  requests: GalleryThumbnailRequest[],
): GalleryThumbnailResolveState {
  const urls: Record<string, string> = {};

  for (const request of requests) {
    const cached = state.cache.get(cacheKey(request));

    if (cached?.status === "ready" && cached.url) {
      urls[request.mediaId] = cached.url;
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
  // Attach to batches already fetching these rows instead of skipping past
  // them: returning a cache snapshot while an earlier batch is still in
  // flight hands back data that is stale on arrival and leaves the caller
  // with neither an eligible row nor a scheduled retry behind it. Waiting
  // here means every caller sees the post-batch state. Batches never
  // reject; they settle to cache state.
  for (;;) {
    const inFlightBatches = new Set<Promise<GalleryThumbnailResolveState>>();

    for (const request of requests) {
      const cached = state.cache.get(cacheKey(request));

      if (cached?.batch) {
        inFlightBatches.add(cached.batch);
      }
    }

    if (inFlightBatches.size === 0) {
      break;
    }

    await Promise.all(inFlightBatches);
  }

  const now = Date.now();
  const uniqueRequests = new Map<string, GalleryThumbnailRequest>();

  for (const request of requests) {
    const key = cacheKey(request);
    const cached = state.cache.get(key);

    if (cached) {
      // Still on screen, so keep it clear of eviction whatever its state: a
      // pending row evicted early would be re-requested before its retry time.
      setCacheEntry(state, key, cached);
    }

    if (cached?.status === "ready") {
      continue;
    }

    if (cached?.status === "failed" || cached?.inFlight) {
      continue;
    }

    if (cached?.nextRetryAt && cached.nextRetryAt > now) {
      continue;
    }

    uniqueRequests.set(key, request);
  }

  const batch = [...uniqueRequests.entries()].slice(0, 48);

  if (batch.length === 0) {
    return readCachedGalleryThumbnailStateFor(state, requests);
  }

  const items = batch.map(([, request]) => ({
    mediaId: request.mediaId,
    size: request.size ?? GALLERY_THUMBNAIL_SIZE,
    variant: "thumbnail" as const,
  }));

  const execution = (async () => {
    try {
      const response = await state.resolveUrls({ data: { items } });

      for (const result of response.results) {
        applyResult(state, result);
      }

      const resolvedKeys = new Set(
        response.results.map((result) => cacheKey({ mediaId: result.mediaId, size: result.size })),
      );

      for (const [key] of batch) {
        if (!resolvedKeys.has(key) && state.cache.get(key)?.inFlight) {
          setCacheEntry(state, key, {
            inFlight: false,
            nextRetryAt: Date.now() + pendingRetryDelayMs(state, key),
            status: "pending",
          });
        }
      }
    } catch {
      const retryAt = Date.now() + 30_000;

      for (const [key] of batch) {
        setCacheEntry(state, key, {
          inFlight: false,
          nextRetryAt: retryAt,
          status: "pending",
        });
      }
    }

    return readCachedGalleryThumbnailStateFor(state, requests);
  })();

  for (const [key] of batch) {
    setCacheEntry(state, key, { batch: execution, inFlight: true, status: "pending" });
  }

  return execution;
}

export function createThumbnailResolver({
  resolveUrls = resolveMediaDeliveryUrls,
}: {
  resolveUrls?: ResolveMediaDeliveryUrls;
} = {}): GalleryThumbnailResolver {
  const state: ThumbnailResolverState = {
    attempts: new Map(),
    cache: new Map(),
    inFlightCount: 0,
    resolveUrls,
  };

  return {
    getNextPendingThumbnailRetryMs: (requests: GalleryThumbnailRequest[]) =>
      getNextPendingThumbnailRetryMsFor(state, requests),
    hasEligibleGalleryThumbnailRequests: (requests: GalleryThumbnailRequest[]) =>
      hasEligibleGalleryThumbnailRequestsFor(state, requests),
    readCachedGalleryThumbnailState: (requests: GalleryThumbnailRequest[]) =>
      readCachedGalleryThumbnailStateFor(state, requests),
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
