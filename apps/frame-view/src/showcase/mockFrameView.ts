import { Result } from 'better-result';

import type {
  AppCommand,
  AppSettings,
  AppSettingsPatch,
  FrameViewApi,
  ScanEvent,
  ScanOptions,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import { buildShowcaseMediaItems, SHOWCASE_FOLDER_PATH } from './sampleArchive';

type ScanListener = (event: ScanEvent) => void;
type CommandListener = (command: AppCommand) => void;

let settingsState: AppSettings = {
  ...DEFAULT_SETTINGS,
  theme: 'dark',
  rememberLastFolder: true,
  lastFolderPath: SHOWCASE_FOLDER_PATH,
  recursiveDefault: false,
};

const scanListeners = new Set<ScanListener>();
const commandListeners = new Set<CommandListener>();

function emitScanEvent(event: ScanEvent): void {
  for (const listener of scanListeners) {
    listener(event);
  }
}

async function emitShowcaseScan(options: ScanOptions): Promise<void> {
  const runId = Date.now();
  const items = buildShowcaseMediaItems();

  emitScanEvent({
    type: 'reset',
    runId,
    rootPath: options.rootPath,
    recursive: options.recursive,
  });

  emitScanEvent({
    type: 'progress',
    runId,
    scannedDirectories: 1,
    discoveredItems: items.length,
    currentPath: options.rootPath,
  });

  emitScanEvent({
    type: 'batch',
    runId,
    items,
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  emitScanEvent({
    type: 'done',
    runId,
    totalItems: items.length,
    elapsedMs: 180,
  });
}

export function installShowcaseFrameViewMock(): void {
  const api: FrameViewApi = {
    openFolderDialog: async () => Result.ok(SHOWCASE_FOLDER_PATH),
    resolveInputPath: async (candidatePath) => Result.ok(candidatePath),
    startScan: async (options) => {
      void emitShowcaseScan(options);
      return Result.ok(undefined);
    },
    cancelScan: async () => Result.ok(undefined),
    listFolderChildren: async () => Result.ok([]),
    getSettings: async () => Result.ok(settingsState),
    updateSettings: async (patch: AppSettingsPatch) => {
      settingsState = {
        ...settingsState,
        ...patch,
        filters: patch.filters
          ? { ...settingsState.filters, ...patch.filters }
          : settingsState.filters,
        debug: patch.debug ? { ...settingsState.debug, ...patch.debug } : settingsState.debug,
        rootGalleryPreferences: patch.rootGalleryPreferences
          ? { ...settingsState.rootGalleryPreferences, ...patch.rootGalleryPreferences }
          : settingsState.rootGalleryPreferences,
      };
      return Result.ok(settingsState);
    },
    revealInFolder: async () => Result.ok(undefined),
    probeVideoMetadata: async () => Result.ok(null),
    clearThumbnailCache: async () => Result.ok(undefined),
    getMediaIndexStats: async () =>
      Result.ok({
        totalItems: buildShowcaseMediaItems().length,
        uniqueRoots: 1,
        dbPath: 'showcase.sqlite',
      }),
    clearMediaIndex: async () => Result.ok(undefined),
    getMediaToolsStatus: async () =>
      Result.ok({
        ffmpegAvailable: true,
        ffprobeAvailable: true,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
      }),
    debug: {
      getDiagnosticsSnapshot: async () =>
        Result.ok({
          appVersion: 'showcase',
          arch: 'arm64',
          currentFolder: {
            folderName: 'photos',
            itemCount: buildShowcaseMediaItems().length,
            recursive: false,
            scanState: 'done',
          },
          debug: settingsState.debug,
          electronVersion: 'showcase',
          isPackaged: false,
          mediaTools: {
            ffmpegAvailable: true,
            ffprobeAvailable: true,
            ffmpegPath: 'ffmpeg',
            ffprobePath: 'ffprobe',
          },
          platform: 'darwin',
          thumbnails: {
            abortedCount: 0,
            diskCacheHits: 0,
            generatedCount: 0,
            imageQueueDepth: 0,
            imageWorkerCount: 0,
            inflightRequests: 0,
            memoryCacheHits: 0,
            recentFailures: [],
            recentWorkerEvents: [],
            sharpDecodeFailureCount: 0,
            timings: null,
            videoExtractionFailureCount: 0,
            videoQueueDepth: 0,
            videoWorkerCount: 0,
            workerCrashCount: 0,
            workerRestartCount: 0,
          },
          thumbnailWorker: null,
          thumbnailWorkerPerformance: null,
        }),
    },
    onAppCommand: (listener) => {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },
    onScanEvent: (listener) => {
      scanListeners.add(listener);
      return () => scanListeners.delete(listener);
    },
  };

  window.frameView = api;
}
