import type { MediaItem, VideoProbeMetadata } from '../../shared/types';
import type { AppStoreSet } from './types';

function patchMediaMetadata(
  items: MediaItem[],
  path: string,
  mtimeMs: number,
  size: number,
  metadata: VideoProbeMetadata,
): { changed: boolean; items: MediaItem[] } {
  const itemIndex = items.findIndex(
    (item) =>
      item.path === path &&
      item.mediaType === 'video' &&
      item.mtimeMs === mtimeMs &&
      item.size === size,
  );

  if (itemIndex < 0) {
    return { changed: false, items };
  }

  const currentItem = items[itemIndex];
  if (!currentItem) {
    return { changed: false, items };
  }

  const hasChanges =
    currentItem.durationMs !== metadata.durationMs ||
    currentItem.width !== metadata.width ||
    currentItem.height !== metadata.height ||
    currentItem.codec !== metadata.codec;

  if (!hasChanges) {
    return { changed: false, items };
  }

  const nextItems = [...items];
  nextItems[itemIndex] = {
    ...currentItem,
    durationMs: metadata.durationMs,
    width: metadata.width,
    height: metadata.height,
    codec: metadata.codec,
  };

  return { changed: true, items: nextItems };
}

export function createApplyVideoMetadata(set: AppStoreSet) {
  return (path: string, mtimeMs: number, size: number, metadata: VideoProbeMetadata): void => {
    set((state) => {
      let hasChanges = false;

      const finalItemsPatch = patchMediaMetadata(state.items, path, mtimeMs, size, metadata);
      hasChanges = hasChanges || finalItemsPatch.changed;

      let nextLoadingChunks = state.loadingChunks;
      for (let chunkIndex = 0; chunkIndex < state.loadingChunks.length; chunkIndex += 1) {
        const chunk = state.loadingChunks[chunkIndex];
        const patchedChunk = patchMediaMetadata(chunk, path, mtimeMs, size, metadata);
        if (!patchedChunk.changed) {
          continue;
        }

        nextLoadingChunks = [...state.loadingChunks];
        nextLoadingChunks[chunkIndex] = patchedChunk.items;
        hasChanges = true;
        break;
      }

      const viewerItemsPatch = state.viewerItemsSnapshot
        ? patchMediaMetadata(state.viewerItemsSnapshot, path, mtimeMs, size, metadata)
        : { changed: false, items: state.viewerItemsSnapshot };
      hasChanges = hasChanges || viewerItemsPatch.changed;

      if (!hasChanges) {
        return {};
      }

      return {
        items: finalItemsPatch.items,
        loadingChunks: nextLoadingChunks,
        viewerItemsSnapshot: viewerItemsPatch.changed
          ? viewerItemsPatch.items
          : state.viewerItemsSnapshot,
      };
    });
  };
}
