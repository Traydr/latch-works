import type { MediaItem } from "@latch-works/media-domain";
import { useState } from "react";

export interface GalleryViewerHandoffResult {
  viewerOpen: boolean;
  viewerItems: MediaItem[] | null;
  viewerLockedMediaId: string | null;
  openViewer: (
    items: MediaItem[],
    startMediaId: string,
    options?: { lockSelectionToMediaId?: string },
  ) => void;
  closeViewer: () => void;
}

/**
 * Manages the viewer open/close state and the items/locked-id handoff to
 * MediaViewerModal. Calls `setSelectedId` when the viewer opens to synchronize
 * gallery selection.
 */
export function useGalleryViewerHandoff(
  setSelectedId: (id: string) => void,
): GalleryViewerHandoffResult {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerItems, setViewerItems] = useState<MediaItem[] | null>(null);
  const [viewerLockedMediaId, setViewerLockedMediaId] = useState<string | null>(null);

  const openViewer = (
    items: MediaItem[],
    startMediaId: string,
    options?: { lockSelectionToMediaId?: string },
  ) => {
    const startIndex = items.findIndex((item) => item.id === startMediaId);
    if (startIndex < 0) {
      return;
    }

    setViewerItems(items);
    setViewerLockedMediaId(options?.lockSelectionToMediaId ?? null);
    setSelectedId(options?.lockSelectionToMediaId ?? startMediaId);
    setViewerOpen(true);
  };

  const closeViewer = () => {
    setViewerOpen(false);
    setViewerItems(null);
    setViewerLockedMediaId(null);
  };

  return {
    viewerOpen,
    viewerItems,
    viewerLockedMediaId,
    openViewer,
    closeViewer,
  };
}
