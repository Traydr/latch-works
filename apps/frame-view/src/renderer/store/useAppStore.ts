import { create } from 'zustand';

import { DEFAULT_SETTINGS } from '../../shared/types';
import { createApplyVideoMetadata } from './metadataState';
import { createApplyScanEvent } from './scanState';
import { createInitializeSettings } from './settingsState';
import type { AppState } from './types';
import { createCloseViewer, createOpenViewerAt, createShiftViewer } from './viewerState';

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  rootPath: null,
  recursive: DEFAULT_SETTINGS.recursiveDefault,
  items: [],
  loadingChunks: [],
  loadingItemCount: 0,
  viewerItemsSnapshot: null,
  selectedId: null,
  viewerIndex: null,
  activeScanRunId: null,
  scanState: 'idle',
  scannedDirectories: 0,
  discoveredItems: 0,
  scanMessage: 'Open a folder to begin',
  initializeSettings: createInitializeSettings(set),
  setRecursive: (value) => set({ recursive: value }),
  setSelectedId: (id) => set({ selectedId: id }),
  openViewerAt: createOpenViewerAt(set),
  closeViewer: createCloseViewer(set),
  shiftViewer: createShiftViewer(set),
  applyScanEvent: createApplyScanEvent(set, get),
  applyVideoMetadata: createApplyVideoMetadata(set),
}));
