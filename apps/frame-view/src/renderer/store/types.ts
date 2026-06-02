import type { AppSettings, MediaItem, ScanEvent, VideoProbeMetadata } from '../../shared/types';

export type ScanState = 'idle' | 'loading' | 'done' | 'error';

export interface AppState {
  settings: AppSettings;
  rootPath: string | null;
  recursive: boolean;
  items: MediaItem[];
  loadingChunks: MediaItem[][];
  loadingItemCount: number;
  viewerItemsSnapshot: MediaItem[] | null;
  selectedId: string | null;
  viewerIndex: number | null;
  activeScanRunId: number | null;
  scanState: ScanState;
  scannedDirectories: number;
  discoveredItems: number;
  scanMessage: string;
  initializeSettings: (settings: AppSettings) => void;
  setRecursive: (value: boolean) => void;
  setSelectedId: (id: string | null) => void;
  openViewerAt: (index: number) => void;
  closeViewer: () => void;
  shiftViewer: (delta: number, shouldWrap: boolean) => void;
  applyScanEvent: (event: ScanEvent) => void;
  applyVideoMetadata: (
    path: string,
    mtimeMs: number,
    size: number,
    metadata: VideoProbeMetadata,
  ) => void;
}

export type AppStoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
) => void;

export type AppStoreGet = () => AppState;
