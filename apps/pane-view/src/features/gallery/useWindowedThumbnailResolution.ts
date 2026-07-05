import type { BrowserEntry } from "@latch-works/media-domain";
import { useCallback, useEffect, useState } from "react";
import {
  type GalleryThumbnailRequest,
  getNextPendingThumbnailRetryMs,
  readCachedGalleryThumbnailState,
  resolveGalleryThumbnailsBatch,
} from "@/features/gallery/batched-thumbnail-resolver";
import {
  areThumbnailRequestsEqual,
  dedupeThumbnailRequests,
  supportsGalleryThumbnail,
} from "@/features/gallery/gallery-page-helpers";
import type { LibraryMediaItem } from "@/server/library/types";

export interface WindowedThumbnailResolutionResult {
  resolvedThumbnailTokens: Record<string, string>;
  resolvedThumbnailUrls: Record<string, string>;
  handleWindowedEntriesChange: (entries: BrowserEntry[]) => void;
}

/**
 * Manages windowed thumbnail request batching and resolution.
 * When `resetKey` changes, clears pending requests and re-reads the cache.
 */
export function useWindowedThumbnailResolution(
  resetKey: string,
): WindowedThumbnailResolutionResult {
  const cached = readCachedGalleryThumbnailState();
  const [windowedThumbnailRequests, setWindowedThumbnailRequests] = useState<
    GalleryThumbnailRequest[]
  >([]);
  const [resolvedThumbnailUrls, setResolvedThumbnailUrls] = useState<Record<string, string>>(
    cached.urls,
  );
  const [resolvedThumbnailTokens, setResolvedThumbnailTokens] = useState<Record<string, string>>(
    cached.deliveryTokens,
  );

  useEffect(() => {
    setWindowedThumbnailRequests([]);
    const fresh = readCachedGalleryThumbnailState();
    setResolvedThumbnailUrls(fresh.urls);
    setResolvedThumbnailTokens(fresh.deliveryTokens);
  }, [resetKey]);

  useEffect(() => {
    if (windowedThumbnailRequests.length === 0) {
      return;
    }

    let cancelled = false;
    let debounceTimeoutId: number | undefined;
    let retryTimeoutId: number | undefined;

    const applyResolvedState = (
      resolved: Awaited<ReturnType<typeof resolveGalleryThumbnailsBatch>>,
    ) => {
      setResolvedThumbnailUrls(resolved.urls);
      setResolvedThumbnailTokens(resolved.deliveryTokens);
    };

    const scheduleRetry = () => {
      if (cancelled) {
        return;
      }

      const retryDelayMs = getNextPendingThumbnailRetryMs(windowedThumbnailRequests);
      if (retryDelayMs === null) {
        return;
      }

      retryTimeoutId = window.setTimeout(() => {
        void resolveGalleryThumbnailsBatch(windowedThumbnailRequests).then((resolved) => {
          if (cancelled) {
            return;
          }

          applyResolvedState(resolved);
          scheduleRetry();
        });
      }, retryDelayMs);
    };

    debounceTimeoutId = window.setTimeout(() => {
      void resolveGalleryThumbnailsBatch(windowedThumbnailRequests).then((resolved) => {
        if (cancelled) {
          return;
        }

        applyResolvedState(resolved);
        scheduleRetry();
      });
    }, 200);

    return () => {
      cancelled = true;
      if (debounceTimeoutId !== undefined) {
        window.clearTimeout(debounceTimeoutId);
      }
      if (retryTimeoutId !== undefined) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [windowedThumbnailRequests]);

  const handleWindowedEntriesChange = useCallback((windowedEntries: BrowserEntry[]) => {
    const requests = dedupeThumbnailRequests(
      windowedEntries.flatMap((entry): GalleryThumbnailRequest[] => {
        if (entry.kind === "folder") {
          return [];
        }

        const media = entry.kind === "comic" ? entry.comic.cover : entry.media;
        const embedded = media as LibraryMediaItem;
        if (
          !supportsGalleryThumbnail(media) ||
          embedded.thumbnailUrl ||
          embedded.thumbnailDeliveryToken
        ) {
          return [];
        }

        return [{ mediaId: media.id }];
      }),
    );

    setWindowedThumbnailRequests((current) =>
      areThumbnailRequestsEqual(current, requests) ? current : requests,
    );
  }, []);

  return {
    resolvedThumbnailTokens,
    resolvedThumbnailUrls,
    handleWindowedEntriesChange,
  };
}
