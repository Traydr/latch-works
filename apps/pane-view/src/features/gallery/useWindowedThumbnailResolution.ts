import { useEffect, useMemo, useRef, useState } from "react";
import {
  type GalleryThumbnailRequest,
  type GalleryThumbnailResolver,
  type GalleryThumbnailResolveState,
  sharedThumbnailResolver,
} from "@/features/gallery/batched-thumbnail-resolver";
import type { GalleryBrowseEntry } from "@/features/gallery/gallery-browse-entry";
import {
  dedupeThumbnailRequests,
  supportsGalleryThumbnail,
} from "@/features/gallery/gallery-page-helpers";

export interface WindowedThumbnailResolutionResult {
  resolvedThumbnailUrls: Record<string, string>;
}

/**
 * The listing on screen, as `useGalleryBrowse` produces it: its content key
 * and its rows move together in one commit because both derive from one
 * `firstPage`.
 */
export interface WindowedListing {
  /** The rows of that listing currently inside the grid's window. */
  entries: GalleryBrowseEntry[];
  /**
   * The browse key of the listing on screen, or null while a placeholder from
   * another browse is showing — see `useGalleryBrowse`.
   */
  key: string | null;
}

/**
 * Coalesces the window changes a scroll produces into one batch per rest. It
 * applies only while the content is unchanged; new content resolves at once,
 * because there is nothing yet to coalesce.
 */
const WINDOW_CHANGE_DEBOUNCE_MS = 200;

/**
 * Resolves thumbnails for the rows currently in the grid's window.
 *
 * Keying off the listing on screen rather than the browse is what makes the
 * cases separable: a new listing resolves immediately, a window that merely
 * moved is debounced, and a placeholder from the outgoing folder — whose key
 * is null — is never resolved against at all.
 */
export function useWindowedThumbnailResolution(
  { entries: windowedEntries, key: contentKey }: WindowedListing,
  resolver: GalleryThumbnailResolver = sharedThumbnailResolver,
): WindowedThumbnailResolutionResult {
  const [resolution, setResolution] = useState(() => {
    const cached = resolver.readCachedGalleryThumbnailState();
    return { contentKey, urls: cached.urls };
  });
  /** The content this hook last scheduled against; anything else is new content. */
  const seenContentKeyRef = useRef<string | null>(null);
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
    resolution.contentKey === contentKey
      ? resolution.urls
      : resolver.readCachedGalleryThumbnailState().urls;

  useEffect(() => {
    // A placeholder listing belongs to the folder being left. Its thumbnails
    // are already cached, so resolving them buys nothing and would spend a
    // retry attempt on rows nobody is going to look at.
    if (contentKey === null || windowedThumbnailRequests.length === 0) {
      return;
    }

    let cancelled = false;
    let debounceTimeoutId: number | undefined;
    let drainTimeoutId: number | undefined;
    let retryTimeoutId: number | undefined;

    const applyResolvedState = (resolved: GalleryThumbnailResolveState) => {
      setResolution({ contentKey, urls: resolved.urls });
    };

    const resolveAndSchedule = () => {
      void resolver.resolveGalleryThumbnailsBatch(windowedThumbnailRequests).then((resolved) => {
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

      const retryDelayMs = resolver.getNextPendingThumbnailRetryMs(windowedThumbnailRequests);
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

      if (resolver.hasEligibleGalleryThumbnailRequests(windowedThumbnailRequests)) {
        drainTimeoutId = window.setTimeout(resolveAndSchedule, 0);
        return;
      }

      scheduleRetry();
    };

    const isNewContent = seenContentKeyRef.current !== contentKey;
    seenContentKeyRef.current = contentKey;

    if (isNewContent) {
      // Synchronously, so there is no window in which a re-render can cancel
      // the one resolve this listing gets before it has issued anything.
      resolveAndSchedule();
    } else {
      debounceTimeoutId = window.setTimeout(() => {
        resolveAndSchedule();
      }, WINDOW_CHANGE_DEBOUNCE_MS);
    }

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
  }, [contentKey, resolver, windowedThumbnailRequests]);

  return {
    resolvedThumbnailUrls,
  };
}
