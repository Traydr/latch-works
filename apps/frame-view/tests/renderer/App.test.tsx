// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Result } from 'better-result';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '../../src/renderer/store/useAppStore';
import { DEFAULT_SETTINGS } from '../../src/shared/types';

vi.mock('../../src/renderer/layouts', () => ({
  PrismLayout: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <button type="button" onClick={onOpenSettings}>
      open-settings
    </button>
  ),
}));

vi.mock('../../src/renderer/components/SettingsDrawer', () => ({
  SettingsDrawer: ({
    isOpen,
    onUpdate,
  }: {
    isOpen: boolean;
    onUpdate: (patch: unknown) => void;
  }) =>
    isOpen ? (
      <button
        type="button"
        onClick={() =>
          onUpdate({
            filters: {
              ...DEFAULT_SETTINGS.filters,
              showVideos: false,
            },
          })
        }
      >
        apply-filter
      </button>
    ) : null,
}));

vi.mock('../../src/renderer/components/ViewerModal', () => ({
  ViewerModal: () => null,
}));

describe('App', () => {
  const initialState = useAppStore.getState();

  beforeEach(() => {
    useAppStore.setState(
      {
        ...initialState,
        rootPath: 'C:\\media',
        recursive: false,
      },
      true,
    );

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      })),
    });

    window.frameView = {
      openFolderDialog: vi.fn(async () => Result.ok(null)),
      resolveInputPath: vi.fn(async () => Result.ok(null)),
      startScan: vi.fn(async () => Result.ok(undefined)),
      cancelScan: vi.fn(async () => Result.ok(undefined)),
      listFolderChildren: vi.fn(async () => Result.ok([])),
      getSettings: vi.fn(async () =>
        Result.ok({
          ...DEFAULT_SETTINGS,
          rememberLastFolder: false,
        }),
      ),
      updateSettings: vi.fn(async (patch) =>
        Result.ok({
          ...DEFAULT_SETTINGS,
          filters:
            typeof patch === 'object' && patch !== null && 'filters' in patch
              ? {
                  ...DEFAULT_SETTINGS.filters,
                  ...(patch as { filters: typeof DEFAULT_SETTINGS.filters }).filters,
                }
              : DEFAULT_SETTINGS.filters,
        }),
      ),
      revealInFolder: vi.fn(async () => Result.ok(undefined)),
      probeVideoMetadata: vi.fn(async () => Result.ok(null)),
      clearThumbnailCache: vi.fn(async () => Result.ok(undefined)),
      getMediaIndexStats: vi.fn(async () =>
        Result.ok({
          totalItems: 0,
          uniqueRoots: 0,
          dbPath: 'index.sqlite',
        }),
      ),
      clearMediaIndex: vi.fn(async () => Result.ok(undefined)),
      getMediaToolsStatus: vi.fn(async () =>
        Result.ok({
          ffmpegAvailable: true,
          ffprobeAvailable: true,
          ffmpegPath: 'ffmpeg',
          ffprobePath: 'ffprobe',
        }),
      ),
      debug: {
        getDiagnosticsSnapshot: vi.fn(async () =>
          Result.ok({
            appVersion: '1.0.13',
            arch: 'x64',
            currentFolder: null,
            debug: DEFAULT_SETTINGS.debug,
            electronVersion: '41.1.1',
            isPackaged: false,
            mediaTools: {
              ffmpegAvailable: true,
              ffprobeAvailable: true,
              ffmpegPath: 'ffmpeg',
              ffprobePath: 'ffprobe',
            },
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
    };
  });

  afterEach(async () => {
    cleanup();
    useAppStore.setState(initialState, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('rescans exactly once when filters are updated from settings', async () => {
    const user = userEvent.setup();
    const { App } = await import('../../src/renderer/App');

    render(<App />);

    await user.click(screen.getByText('open-settings'));
    await user.click(await screen.findByText('apply-filter'));

    await waitFor(() => {
      expect(window.frameView.updateSettings).toHaveBeenCalledTimes(1);
      expect(window.frameView.startScan).toHaveBeenCalledTimes(1);
    });
  });

  it('bootstraps a remembered folder without restarting bootstrap side effects', async () => {
    const { App } = await import('../../src/renderer/App');

    vi.mocked(window.frameView.getSettings).mockResolvedValue(
      Result.ok({
        ...DEFAULT_SETTINGS,
        lastFolderPath: 'C:\\media',
        rememberLastFolder: true,
      }),
    );

    render(<App />);

    await waitFor(() => {
      expect(window.frameView.getSettings).toHaveBeenCalledTimes(1);
      expect(window.frameView.startScan).toHaveBeenCalledTimes(1);
      expect(window.frameView.startScan).toHaveBeenCalledWith({
        rootPath: 'C:\\media',
        recursive: DEFAULT_SETTINGS.recursiveDefault,
        filters: DEFAULT_SETTINGS.filters,
        excludedRootChildPaths: [],
      });
    });

    expect(window.frameView.cancelScan).not.toHaveBeenCalled();
  });
});
