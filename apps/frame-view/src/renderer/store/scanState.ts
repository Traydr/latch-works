import type { ScanEvent } from '../../shared/types';
import { sortMediaItems } from '../utils/sort';
import { flattenLoadingChunks, sortAndSyncSelection } from './selectionState';
import type { AppStoreGet, AppStoreSet } from './types';

export function createApplyScanEvent(set: AppStoreSet, get: AppStoreGet) {
  return (event: ScanEvent): void => {
    const state = get();

    switch (event.type) {
      case 'reset':
        set({
          activeScanRunId: event.runId,
          rootPath: event.rootPath,
          recursive: event.recursive,
          items: [],
          loadingChunks: [],
          loadingItemCount: 0,
          viewerItemsSnapshot: null,
          selectedId: null,
          viewerIndex: null,
          scanState: 'loading',
          scannedDirectories: 0,
          discoveredItems: 0,
          scanMessage: 'Scanning folder...',
        });
        break;
      case 'progress':
        if (state.activeScanRunId !== event.runId) {
          break;
        }
        set({
          scannedDirectories: event.scannedDirectories,
          discoveredItems: event.discoveredItems,
          scanState: 'loading',
          scanMessage: `Scanning ${event.currentPath}`,
        });
        break;
      case 'batch':
        if (state.activeScanRunId !== event.runId) {
          break;
        }
        set((current) => {
          if (current.activeScanRunId !== event.runId) {
            return {};
          }

          return {
            loadingChunks: [...current.loadingChunks, event.items],
            loadingItemCount: current.loadingItemCount + event.items.length,
            discoveredItems: current.discoveredItems + event.items.length,
          };
        });
        break;
      case 'done':
        if (state.activeScanRunId !== event.runId) {
          break;
        }
        set((current) => {
          if (current.activeScanRunId !== event.runId) {
            return {};
          }

          const flattenedItems = flattenLoadingChunks(current.loadingChunks);

          if (current.viewerItemsSnapshot && current.viewerIndex !== null) {
            const currentViewerItem = current.viewerItemsSnapshot[current.viewerIndex] ?? null;

            return {
              activeScanRunId: null,
              items: sortMediaItems(
                flattenedItems,
                current.settings.sortMode,
                current.settings.randomSeed,
              ),
              loadingChunks: [],
              loadingItemCount: 0,
              selectedId: currentViewerItem?.id ?? current.selectedId,
              viewerIndex: currentViewerItem ? current.viewerIndex : null,
              scanState: 'done',
              discoveredItems: event.totalItems,
              scanMessage: `Loaded ${event.totalItems} item(s) in ${(event.elapsedMs / 1000).toFixed(1)}s`,
            };
          }

          const synced = sortAndSyncSelection(
            flattenedItems,
            current.settings,
            current.selectedId,
            current.viewerIndex,
          );

          return {
            activeScanRunId: null,
            items: synced.items,
            loadingChunks: [],
            loadingItemCount: 0,
            selectedId: synced.selectedId,
            viewerIndex: synced.viewerIndex,
            scanState: 'done',
            discoveredItems: event.totalItems,
            scanMessage: `Loaded ${event.totalItems} item(s) in ${(event.elapsedMs / 1000).toFixed(1)}s`,
          };
        });
        break;
      case 'cancelled':
        if (state.activeScanRunId !== event.runId) {
          break;
        }
        set((current) => ({
          activeScanRunId: null,
          items:
            current.items.length > 0 ? current.items : flattenLoadingChunks(current.loadingChunks),
          loadingChunks: [],
          loadingItemCount: 0,
          scanState: 'idle',
          scanMessage: 'Scan cancelled',
        }));
        break;
      case 'error': {
        if (event.runId !== undefined && state.activeScanRunId !== event.runId) {
          break;
        }

        const isActiveRunError = event.runId !== undefined && state.activeScanRunId === event.runId;

        set({
          scanState: isActiveRunError ? 'loading' : 'error',
          scanMessage: event.path ? `${event.message}: ${event.path}` : event.message,
        });
        break;
      }
      default:
        break;
    }
  };
}
