import { useEffect, useMemo, useRef, useState } from "react";
import {
  type DeliveryCacheRequest,
  deliveryCache,
  type SettledDelivery,
} from "@/features/delivery/delivery-cache";
import { hasDeliverableRendition, THUMBNAIL_WIDTH } from "@/features/delivery/delivery-contract";
import { entryMedia, type GalleryBrowseEntry } from "@/features/library/listing-contract";

export interface WindowedThumbnailResolutionResult {
  /** Settled thumbnails by media id; an item still resolving has none. */
  thumbnails: ReadonlyMap<string, SettledDelivery>;
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
export function useWindowedThumbnailResolution({
  entries: windowedEntries,
  key: contentKey,
}: WindowedListing): WindowedThumbnailResolutionResult {
  /** The last batch's answers, with the window requests they answer. */
  const [resolution, setResolution] = useState<{
    requests: DeliveryCacheRequest[];
    thumbnails: ReadonlyMap<string, SettledDelivery>;
  } | null>(null);

  /** The content this hook last scheduled against; anything else is new content. */
  const seenContentKeyRef = useRef<string | null>(null);

  const windowedThumbnailRequests = useMemo(
    () =>
      windowedEntries.flatMap((entry): DeliveryCacheRequest[] => {
        const media = entryMedia(entry);

        return media && hasDeliverableRendition(media.mediaType)
          ? [
              {
                mediaId: media.id,
                revision: media.sha256,
                variant: "thumbnail",
                width: THUMBNAIL_WIDTH,
              },
            ]
          : [];
      }),
    [windowedEntries],
  );

  // A window no batch has answered yet shows what the cache already holds for it.
  const cachedThumbnails = useMemo(
    () => deliveryCache.settled(windowedThumbnailRequests),
    [windowedThumbnailRequests],
  );

  const thumbnails =
    resolution?.requests === windowedThumbnailRequests ? resolution.thumbnails : cachedThumbnails;

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
    let resolving = false;

    const resolveAndSchedule = () => {
      resolving = true;
      void deliveryCache.resolveWindow(windowedThumbnailRequests).then(() => {
        resolving = false;

        if (cancelled) {
          return;
        }

        setResolution({
          requests: windowedThumbnailRequests,
          thumbnails: deliveryCache.settled(windowedThumbnailRequests),
        });
        scheduleNext();
      });
    };

    const scheduleRetry = () => {
      if (cancelled) {
        return;
      }

      const retryDelayMs = deliveryCache.nextAttemptInMs(windowedThumbnailRequests);

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

      if (deliveryCache.nextAttemptInMs(windowedThumbnailRequests) === 0) {
        drainTimeoutId = window.setTimeout(resolveAndSchedule, 0);

        return;
      }

      scheduleRetry();
    };

    // A user refresh made failed rows eligible; resolve now, not at the next
    // retry time. A resolve already running drains them when it settles.
    const unsubscribe = deliveryCache.subscribeToRetries(() => {
      if (resolving) {
        return;
      }

      if (retryTimeoutId !== undefined) {
        window.clearTimeout(retryTimeoutId);
        retryTimeoutId = undefined;
      }

      resolveAndSchedule();
    });

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
      unsubscribe();

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
  }, [contentKey, windowedThumbnailRequests]);

  return { thumbnails };
}
