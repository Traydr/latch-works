import { useCallback, useState } from "react";

export interface GalleryViewerHandoffResult {
  closeViewer: () => void;
  /** Select `mediaId` through the browse state and open the viewer on it. */
  openViewer: (mediaId: string) => void;
  viewerOpen: boolean;
}

/**
 * Whether the viewer is open. The viewer itself follows the live browse
 * session and the selected media id (Plan 052, Decision 6), so nothing is
 * captured here at open time.
 */
export function useGalleryViewerHandoff(
  selectMedia: (mediaId: string) => void,
): GalleryViewerHandoffResult {
  const [viewerOpen, setViewerOpen] = useState(false);

  const openViewer = useCallback(
    (mediaId: string) => {
      selectMedia(mediaId);
      setViewerOpen(true);
    },
    [selectMedia],
  );

  const closeViewer = useCallback(() => {
    setViewerOpen(false);
  }, []);

  return { closeViewer, openViewer, viewerOpen };
}
