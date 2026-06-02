import type { AppSettings, MediaItem } from '../../shared/types';
import { sortMediaItems } from '../utils/sort';

export function flattenLoadingChunks(chunks: MediaItem[][]): MediaItem[] {
  return chunks.flat();
}

export function sortAndSyncSelection(
  items: MediaItem[],
  settings: AppSettings,
  selectedId: string | null,
  viewerIndex: number | null,
): {
  items: MediaItem[];
  selectedId: string | null;
  viewerIndex: number | null;
} {
  const sortedItems = sortMediaItems(items, settings.sortMode, settings.randomSeed);

  let nextSelectedId = selectedId;
  if (nextSelectedId && !sortedItems.some((item) => item.id === nextSelectedId)) {
    nextSelectedId = null;
  }

  let nextViewerIndex = viewerIndex;
  if (viewerIndex !== null) {
    if (nextSelectedId) {
      const selectedIndex = sortedItems.findIndex((item) => item.id === nextSelectedId);
      if (selectedIndex >= 0) {
        nextViewerIndex = selectedIndex;
      } else if (sortedItems.length > 0) {
        nextViewerIndex = 0;
        nextSelectedId = sortedItems[0].id;
      } else {
        nextViewerIndex = null;
      }
    } else if (sortedItems.length > 0) {
      const clampedIndex = Math.max(0, Math.min(viewerIndex, sortedItems.length - 1));
      nextViewerIndex = clampedIndex;
      nextSelectedId = sortedItems[clampedIndex].id;
    } else {
      nextViewerIndex = null;
    }
  }

  return {
    items: sortedItems,
    selectedId: nextSelectedId,
    viewerIndex: nextViewerIndex,
  };
}
