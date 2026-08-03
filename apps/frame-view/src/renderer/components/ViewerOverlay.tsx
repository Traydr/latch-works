import type { JSX } from 'react';

import { useAppStore } from '../store/useAppStore';
import { ViewerModal } from './ViewerModal';

export function ViewerOverlay(): JSX.Element | null {
  const items = useAppStore((state) => state.items);
  const viewerItemsSnapshot = useAppStore((state) => state.viewerItemsSnapshot);
  const viewerIndex = useAppStore((state) => state.viewerIndex);
  const settings = useAppStore((state) => state.settings);
  const closeViewer = useAppStore((state) => state.closeViewer);
  const shiftViewer = useAppStore((state) => state.shiftViewer);

  if (viewerIndex === null) {
    return null;
  }

  const activeViewerItems = viewerItemsSnapshot ?? items;
  const canStepBackward = settings.loopViewerNavigation || viewerIndex > 0;
  const canStepForward =
    settings.loopViewerNavigation ||
    (activeViewerItems.length > 0 && viewerIndex < activeViewerItems.length - 1);

  return (
    <ViewerModal
      key={activeViewerItems[viewerIndex]?.id ?? viewerIndex}
      items={activeViewerItems}
      index={viewerIndex}
      autoplayVideos={settings.autoplayVideos}
      loopVideos={settings.loopVideos}
      canStepBackward={canStepBackward}
      canStepForward={canStepForward}
      onClose={closeViewer}
      onStep={(delta) => shiftViewer(delta, settings.loopViewerNavigation)}
    />
  );
}
