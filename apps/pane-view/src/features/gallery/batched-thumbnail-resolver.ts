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

interface ThumbnailCacheEntry {
  inFlight: boolean;
  nextRetryAt?: number;
  status: "failed" | "pending" | "ready";
  url?: string;
}

const PENDING_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const;
const cache = new Map<string, ThumbnailCacheEntry>();
const attempts = new Map<string, number>();

function cacheKey(request: GalleryThumbnailRequest): string {
  return `${request.mediaId}:${request.size ?? GALLERY_THUMBNAIL_SIZE}`;
}

function pendingRetryDelayMs(key: string, serverRetryAfterMs?: number): number {
  const attempt = attempts.get(key) ?? 0;
  const baseDelay =
    PENDING_RETRY_DELAYS_MS[Math.min(attempt, PENDING_RETRY_DELAYS_MS.length - 1)] ?? 60_000;
  attempts.set(key, attempt + 1);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.max(serverRetryAfterMs ?? 0, Math.round(baseDelay * jitter));
}

function applyResult(result: MediaDeliveryBatchResult): void {
  const key = cacheKey({
    mediaId: result.mediaId,
    size: result.size,
  });

  if (result.status === "ready") {
    if (!result.url) {
      cache.set(key, {
        inFlight: false,
        nextRetryAt: Date.now() + pendingRetryDelayMs(key),
        status: "pending",
      });
      return;
    }

    attempts.delete(key);
    cache.set(key, {
      status: "ready",
      url: result.url,
      inFlight: false,
    });
    return;
  }

  if (result.status === "pending") {
    cache.set(key, {
      inFlight: false,
      nextRetryAt: Date.now() + pendingRetryDelayMs(key, result.retryAfterMs),
      status: "pending",
    });
    return;
  }

  attempts.delete(key);
  cache.set(key, { inFlight: false, status: "failed" });
}

export function readCachedGalleryThumbnailState(): GalleryThumbnailResolveState {
  const urls: Record<string, string> = {};

  for (const [key, entry] of cache) {
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

export function getNextPendingThumbnailRetryMs(requests: GalleryThumbnailRequest[]): number | null {
  const now = Date.now();
  let earliestDelay: number | null = null;

  for (const request of requests) {
    const cached = cache.get(cacheKey(request));
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

export async function resolveGalleryThumbnailsBatch(
  requests: GalleryThumbnailRequest[],
): Promise<GalleryThumbnailResolveState> {
  const now = Date.now();
  const uniqueRequests = new Map<string, GalleryThumbnailRequest>();

  for (const request of requests) {
    const key = cacheKey(request);
    const cached = cache.get(key);
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
    return readCachedGalleryThumbnailState();
  }

  for (const [key] of batch) {
    cache.set(key, { inFlight: true, status: "pending" });
  }

  try {
    const response = await resolveMediaDeliveryUrls({
      data: {
        items: batch.map(([, request]) => ({
          mediaId: request.mediaId,
          size: request.size ?? GALLERY_THUMBNAIL_SIZE,
          variant: "thumbnail" as const,
        })),
      },
    });

    for (const result of response.results) {
      applyResult(result);
    }

    const resolvedKeys = new Set(
      response.results.map((result) => cacheKey({ mediaId: result.mediaId, size: result.size })),
    );
    for (const [key] of batch) {
      if (!resolvedKeys.has(key) && cache.get(key)?.inFlight) {
        cache.set(key, {
          inFlight: false,
          nextRetryAt: Date.now() + pendingRetryDelayMs(key),
          status: "pending",
        });
      }
    }
  } catch {
    const retryAt = Date.now() + 30_000;
    for (const [key] of batch) {
      cache.set(key, {
        inFlight: false,
        nextRetryAt: retryAt,
        status: "pending",
      });
    }
  }

  return readCachedGalleryThumbnailState();
}

export function __resetGalleryThumbnailResolverForTests(): void {
  cache.clear();
  attempts.clear();
}
