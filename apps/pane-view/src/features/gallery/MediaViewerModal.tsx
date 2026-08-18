import type { MediaItem } from "@latch-works/media-domain";
import { type JSX, useCallback, useEffect, useRef } from "react";
import type { ViewerStateStore } from "@/features/viewer/use-library-viewer-state";
import { MediaViewerSession } from "./MediaViewerSession";
import { type ResolvedMediaUrlCache, useResolvedMediaUrl } from "./useResolvedMediaUrl";

function usePrefetchNeighborPreview(
  item: MediaItem | undefined,
  cache: ResolvedMediaUrlCache | undefined,
): void {
  const { resolvedUrl } = useResolvedMediaUrl({
    cache,
    mediaId: item?.mediaType === "image" ? item.id : undefined,
    variant: "preview",
  });

  useEffect(() => {
    if (resolvedUrl) {
      new window.Image().src = resolvedUrl;
    }
  }, [resolvedUrl]);
}

export interface MediaViewerModalProps {
  autoplayVideos: boolean;
  /** Overrides the shared URL cache; tests inject a cache with a fake resolver. */
  cache?: ResolvedMediaUrlCache;
  /** True while the browse session still has unloaded pages. */
  hasMore: boolean;
  /** The live media sequence from the browse session, in display order. */
  items: readonly MediaItem[];
  loopNavigation: boolean;
  loopVideos: boolean;
  /** The current media id (the browse selection). */
  mediaId: string;
  onClose: () => void;
  /** Called with the id to show next; the caller writes it to the selection. */
  onSelect: (mediaId: string) => void;
  rememberViewerPosition: boolean;
  /** Overrides the viewer-state server calls; tests inject an in-memory store. */
  viewerStateStore?: ViewerStateStore;
  /**
   * Resolve one step from `mediaId`: the neighbour, the first item of a
   * freshly loaded page, a wrap, or null to stay. Provided by the session.
   */
  stepMedia: (currentId: string, direction: -1 | 1, loop: boolean) => Promise<string | null>;
}

/**
 * The viewer is controlled by media id (Plan 052, Decision 6): it renders the
 * item the browse selection points at, sees pages appended while it is open,
 * and asks the session to step so forward navigation loads before it loops
 * and backward stays put on the first item while more pages exist.
 */
export function MediaViewerModal({
  autoplayVideos,
  cache,
  hasMore,
  items,
  loopNavigation,
  loopVideos,
  mediaId,
  onClose,
  onSelect,
  rememberViewerPosition,
  stepMedia,
  viewerStateStore,
}: MediaViewerModalProps): JSX.Element | null {
  const index = items.findIndex((candidate) => candidate.id === mediaId);
  const lastItemRef = useRef<MediaItem | undefined>(undefined);
  const current = index >= 0 ? items[index] : undefined;
  if (current) {
    lastItemRef.current = current;
  }
  // Keep the last item mounted if it left the sequence (deleted, filtered)
  // until the selection moves on; never blank the dialog under the user.
  const item = current ?? lastItemRef.current;

  const steppingRef = useRef(false);
  const step = useCallback(
    (delta: -1 | 1) => {
      // Repeated forward presses during a page load must not queue extra
      // steps or issue extra requests; Escape is handled by the session dialog.
      if (steppingRef.current) {
        return;
      }
      steppingRef.current = true;
      void stepMedia(mediaId, delta, loopNavigation)
        .then((nextId) => {
          if (nextId && nextId !== mediaId) {
            onSelect(nextId);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          steppingRef.current = false;
        });
    },
    [loopNavigation, mediaId, onSelect, stepMedia],
  );

  const canStepForward =
    index >= 0 && (index < items.length - 1 || hasMore || (loopNavigation && items.length > 1));
  const canStepBackward =
    index > 0 || (index >= 0 && loopNavigation && !hasMore && items.length > 1);

  const neighbor = (delta: -1 | 1): MediaItem | undefined => {
    if (index < 0 || items.length < 2) {
      return undefined;
    }
    const target = index + delta;
    if (target >= 0 && target < items.length) {
      return items[target];
    }
    return loopNavigation && !hasMore ? items[(target + items.length) % items.length] : undefined;
  };
  usePrefetchNeighborPreview(neighbor(-1), cache);
  usePrefetchNeighborPreview(neighbor(1), cache);

  if (!item) {
    return null;
  }

  return (
    <MediaViewerSession
      key={item.id}
      autoplayVideos={autoplayVideos}
      cache={cache}
      canStepBackward={canStepBackward}
      canStepForward={canStepForward}
      item={item}
      loopVideos={loopVideos}
      onClose={onClose}
      onStep={step}
      rememberViewerPosition={rememberViewerPosition}
      viewerStateStore={viewerStateStore}
    />
  );
}
