import { flattenLoadingChunks } from './selectionState';
import type { AppStoreSet } from './types';

export function createOpenViewerAt(set: AppStoreSet) {
  return (index: number): void => {
    set((state) => {
      const sourceItems =
        state.scanState === 'loading'
          ? (state.viewerItemsSnapshot ?? flattenLoadingChunks(state.loadingChunks))
          : state.items;

      if (index < 0 || index >= sourceItems.length) {
        return {};
      }

      const item = sourceItems[index];
      if (!item) {
        return {};
      }

      return {
        viewerIndex: index,
        selectedId: item.id,
        viewerItemsSnapshot:
          state.scanState === 'loading' ? (state.viewerItemsSnapshot ?? sourceItems) : null,
      };
    });
  };
}

export function createCloseViewer(set: AppStoreSet) {
  return (): void => {
    set({ viewerIndex: null, viewerItemsSnapshot: null });
  };
}

export function createShiftViewer(set: AppStoreSet) {
  return (delta: number, shouldWrap: boolean): void => {
    set((state) => {
      const sourceItems = state.viewerItemsSnapshot ?? state.items;

      if (state.viewerIndex === null || sourceItems.length === 0) {
        return {};
      }

      const rawIndex = state.viewerIndex + delta;
      const nextIndex = shouldWrap
        ? ((rawIndex % sourceItems.length) + sourceItems.length) % sourceItems.length
        : Math.max(0, Math.min(rawIndex, sourceItems.length - 1));

      if (!shouldWrap && nextIndex === state.viewerIndex) {
        return {};
      }

      const nextItem = sourceItems[nextIndex];
      if (!nextItem) {
        return {};
      }

      return { viewerIndex: nextIndex, selectedId: nextItem.id };
    });
  };
}
