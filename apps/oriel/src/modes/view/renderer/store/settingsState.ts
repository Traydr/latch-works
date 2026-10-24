import type { AppSettings } from '../../shared/types';
import { sortAndSyncSelection } from './selectionState';
import type { AppStoreSet } from './types';

export function createInitializeSettings(set: AppStoreSet) {
  return (settings: AppSettings): void => {
    set((state) => {
      const synced = sortAndSyncSelection(
        state.items,
        settings,
        state.selectedId,
        state.scanState === 'loading' ? null : state.viewerIndex,
      );

      return {
        settings,
        recursive: state.rootPath ? state.recursive : settings.recursiveDefault,
        items: synced.items,
        selectedId: state.viewerItemsSnapshot ? state.selectedId : synced.selectedId,
        viewerIndex: state.viewerItemsSnapshot ? state.viewerIndex : synced.viewerIndex,
      };
    });
  };
}
