import type { BrowserEntry } from "@latch-works/media-domain";
import { useEffect, useMemo, useState } from "react";
import {
  type GalleryThumbnailRequest,
  getNextPendingThumbnailRetryMs,
  hasEligibleGalleryThumbnailRequests,
  readCachedGalleryThumbnailState,
  resolveGalleryThumbnailsBatch,
} from "@/features/gallery/batched-thumbnail-resolver";
import {
  dedupeThumbnailRequests,
  supportsGalleryThumbnail,
} from "@/features/gallery/gallery-page-helpers";

export interface WindowedThumbnailResolutionResult {
  resolvedThumbnailUrls: Record<string, string>;
}

/**
 * Manages windowed thumbnail request batching and resolution.
 * When `resetKey` changes, clears pending requests and re-reads the cache.
 */
export function useWindowedThumbnailResolution(
  resetKey: string,
  windowedEntries: BrowserEntry[],
): WindowedThumbnailResolutionResult {
  const [resolution, setResolution] = useState(() => {
    const cached = readCachedGalleryThumbnailState();
    return { resetKey, urls: cached.urls };
  });
  const windowedThumbnailRequests = useMemo(
    () =>
      dedupeThumbnailRequests(
        windowedEntries.flatMap((entry): GalleryThumbnailRequest[] => {
          if (entry.kind === "folder") {
            return [];
          }

          const media = entry.kind === "comic" ? entry.comic.cover : entry.media;
          return supportsGalleryThumbnail(media) ? [{ mediaId: media.id }] : [];
        }),
      ),
    [windowedEntries],
  );
  const resolvedThumbnailUrls =
    resolution.resetKey === resetKey ? resolution.urls : readCachedGalleryThumbnailState().urls;

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
      setResolution({ resetKey, urls: resolved.urls });
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

  return {
    resolvedThumbnailUrls,
  };
}
