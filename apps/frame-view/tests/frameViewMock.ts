import { Result } from 'better-result';
import { vi } from 'vitest';

import type { AppSettingsPatch, FrameViewApi } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';

/**
 * Builds a fully stubbed `window.frameView` preload surface.
 *
 * Renderer tests only ever care about two or three of these channels, but the
 * bridge is all-or-nothing at runtime — a missing method throws rather than
 * failing the assertion under test. Centralizing the stub means adding an IPC
 * channel is a one-line change here instead of an edit in every renderer test.
 */
export function createFrameViewMock(overrides: Partial<FrameViewApi> = {}): FrameViewApi {
  const mediaTools = {
    ffmpegAvailable: true,
    ffprobeAvailable: true,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
  };

  const api: FrameViewApi = {
    openFolderDialog: vi.fn(async () => Result.ok(null)),
    resolveInputPath: vi.fn(async () => Result.ok(null)),
    startScan: vi.fn(async () => Result.ok(undefined)),
    cancelScan: vi.fn(async () => Result.ok(undefined)),
    listFolderChildren: vi.fn(async () => Result.ok([])),
    getSettings: vi.fn(async () => Result.ok({ ...DEFAULT_SETTINGS, rememberLastFolder: false })),
    updateSettings: vi.fn(async (patch: AppSettingsPatch) =>
      Result.ok({
        ...DEFAULT_SETTINGS,
        filters: {
          ...DEFAULT_SETTINGS.filters,
          ...patch.filters,
        },
      }),
    ),
    revealInFolder: vi.fn(async () => Result.ok(undefined)),
    probeVideoMetadata: vi.fn(async () => Result.ok(null)),
    clearThumbnailCache: vi.fn(async () => Result.ok(undefined)),
    getMediaIndexStats: vi.fn(async () =>
      Result.ok({ totalItems: 0, uniqueRoots: 0, dbPath: 'index.sqlite' }),
    ),
    clearMediaIndex: vi.fn(async () => Result.ok(undefined)),
    getMediaToolsStatus: vi.fn(async () => Result.ok(mediaTools)),
    debug: {
      getDiagnosticsSnapshot: vi.fn(async () =>
        Result.ok({
          appVersion: '1.0.13',
          arch: 'x64',
          currentFolder: null,
          debug: DEFAULT_SETTINGS.debug,
          electronVersion: '41.1.1',
          isPackaged: false,
          mediaTools,
          platform: 'win32',
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
      ),
    },
    onAppCommand: vi.fn(() => () => undefined),
    onScanEvent: vi.fn(() => () => undefined),
    ...overrides,
  };

  return api;
}
