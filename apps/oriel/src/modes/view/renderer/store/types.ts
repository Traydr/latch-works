import type {
  AppSettings,
  MediaItem,
  ScanEvent,
  ScanOptions,
  VideoProbeMetadata,
} from '../../shared/types';

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
  /** Counts scans that have started, so views derived from the folder on disk can re-read it. */
  scanStartCount: number;
  /**
   * The scan the renderer asked for most recently, which may not have started yet. Work that
   * finishes later checks it, so it refreshes what the user last chose instead of replacing it.
   */
  requestedScan: ScanOptions | null;
  scanState: ScanState;
  scannedDirectories: number;
  discoveredItems: number;
  scanMessage: string;
  /** The path `scanMessage` is about, shown after it and clipped from the start. */
  scanMessagePath: string | null;
  initializeSettings: (settings: AppSettings) => void;
  setRecursive: (value: boolean) => void;
  setSelectedId: (id: string | null) => void;
  openViewerAt: (index: number) => void;
  closeViewer: () => void;
  shiftViewer: (delta: number, shouldWrap: boolean) => void;
  applyScanEvent: (event: ScanEvent) => void;
  supersedeActiveScan: (request: ScanOptions) => void;
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
