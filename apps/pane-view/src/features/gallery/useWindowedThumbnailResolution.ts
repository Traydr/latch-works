import type { BrowserEntry } from "@latch-works/media-domain";
import { useCallback, useEffect, useState } from "react";
import {
  type GalleryThumbnailRequest,
  getNextPendingThumbnailRetryMs,
  hasEligibleGalleryThumbnailRequests,
  readCachedGalleryThumbnailState,
  resolveGalleryThumbnailsBatch,
} from "@/features/gallery/batched-thumbnail-resolver";
import {
  areThumbnailRequestsEqual,
  dedupeThumbnailRequests,
  supportsGalleryThumbnail,
} from "@/features/gallery/gallery-page-helpers";

export interface WindowedThumbnailResolutionResult {
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

  useEffect(() => {
    setWindowedThumbnailRequests([]);
    const fresh = readCachedGalleryThumbnailState();
    setResolvedThumbnailUrls(fresh.urls);
  }, [resetKey]);

  useEffect(() => {
    if (windowedThumbnailRequests.length === 0) {
      return;
    }

    let cancelled = false;
    let debounceTimeoutId: number | undefined;
    let drainTimeoutId: number | undefined;
    let retryTimeoutId: number | undefined;

    const applyResolvedState = (
      resolved: Awaited<ReturnType<typeof resolveGalleryThumbnailsBatch>>,
    ) => {
      setResolvedThumbnailUrls(resolved.urls);
    };

    const resolveAndSchedule = () => {
      void resolveGalleryThumbnailsBatch(windowedThumbnailRequests).then((resolved) => {
        if (cancelled) {
          return;
        }

        applyResolvedState(resolved);
        scheduleNext();
      });
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
        resolveAndSchedule();
      }, retryDelayMs);
    };

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }

      if (hasEligibleGalleryThumbnailRequests(windowedThumbnailRequests)) {
        drainTimeoutId = window.setTimeout(resolveAndSchedule, 0);
        return;
      }

      scheduleRetry();
    };

    debounceTimeoutId = window.setTimeout(() => {
      resolveAndSchedule();
    }, 200);

    return () => {
      cancelled = true;
      if (debounceTimeoutId !== undefined) {
        window.clearTimeout(debounceTimeoutId);
      }
      if (drainTimeoutId !== undefined) {
        window.clearTimeout(drainTimeoutId);
      }
      if (retryTimeoutId !== undefined) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [resetKey, windowedThumbnailRequests]);

  const handleWindowedEntriesChange = useCallback((windowedEntries: BrowserEntry[]) => {
    const requests = dedupeThumbnailRequests(
      windowedEntries.flatMap((entry): GalleryThumbnailRequest[] => {
        if (entry.kind === "folder") {
          return [];
        }

        const media = entry.kind === "comic" ? entry.comic.cover : entry.media;
        if (!supportsGalleryThumbnail(media)) {
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
    resolvedThumbnailUrls,
    handleWindowedEntriesChange,
  };
}
