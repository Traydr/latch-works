import { Result } from 'better-result';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { WorkerError } from '../../../src/main/errors';
import { deserializeIpcResult } from '../../../src/shared/ipc';
import { DEFAULT_SETTINGS } from '../../../src/shared/types';

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const removeHandler = vi.fn((channel: string) => {
  handlers.delete(channel);
});
const handle = vi.fn((channel: string, handlerFn: (...args: unknown[]) => Promise<unknown>) => {
  handlers.set(channel, handlerFn);
});
const showOpenDialog = vi.fn();
const showItemInFolder = vi.fn();

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.13',
    isPackaged: false,
  },
  dialog: {
    showOpenDialog,
  },
  ipcMain: {
    handle,
    removeHandler,
  },
  shell: {
    showItemInFolder,
  },
}));

const resolveFolderPath = vi.fn();
const listFolderChildren = vi.fn();

vi.mock('../../../src/main/services/folderService', () => ({
  listFolderChildren,
  resolveFolderPath,
}));

const authorizeMediaRoot = vi.fn();
const clearThumbnailCache = vi.fn();
const getThumbnailDiagnostics = vi.fn(() => null);
const getThumbnailWorkerCapabilities = vi.fn(() => null);
const isAuthorizedMediaPath = vi.fn();
const setThumbnailDebugOptions = vi.fn();

vi.mock('../../../src/main/services/mediaProtocol', () => ({
  authorizeMediaRoot,
  clearThumbnailCache,
  getThumbnailDiagnostics,
  getThumbnailWorkerCapabilities,
  isAuthorizedMediaPath,
  setThumbnailDebugOptions,
}));

describe('registerIpc', () => {
  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    handle.mockClear();
    showOpenDialog.mockReset();
    showItemInFolder.mockReset();
    resolveFolderPath.mockReset();
    listFolderChildren.mockReset();
    authorizeMediaRoot.mockReset();
    clearThumbnailCache.mockReset();
    isAuthorizedMediaPath.mockReset();
    setThumbnailDebugOptions.mockReset();
    vi.resetModules();
  });

  async function setup() {
    const { registerIpc } = await import('../../../src/main/ipc/registerIpc');
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn(),
      },
    };
    const settingsService = {
      getSettings: vi.fn(() => DEFAULT_SETTINGS),
      updateSettings: vi.fn(async (patch: unknown) =>
        Result.ok({
          ...DEFAULT_SETTINGS,
          lastFolderPath:
            typeof patch === 'object' && patch !== null && 'lastFolderPath' in patch
              ? (patch as { lastFolderPath: string | null }).lastFolderPath
              : DEFAULT_SETTINGS.lastFolderPath,
        }),
      ),
    };
    const catalogService = {
      cancelScan: vi.fn(async () => Result.ok(undefined)),
      clearIndex: vi.fn(async () => Result.ok(undefined)),
      getMediaIndexStats: vi.fn(async () =>
        Result.ok({
          totalItems: 0,
          uniqueRoots: 0,
          dbPath: 'index.sqlite',
        }),
      ),
      startScan: vi.fn(async () => Result.ok(undefined)),
    };
    const mediaToolsService = {
      getStatus: vi.fn(() => ({
        ffmpegAvailable: true,
        ffprobeAvailable: true,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
      })),
      probeVideo: vi.fn(async () => null),
    };

    registerIpc(
      mainWindow as never,
      settingsService as never,
      catalogService as never,
      mediaToolsService as never,
    );

    return {
      catalogService,
      mainWindow,
      mediaToolsService,
      settingsService,
    };
  }

  it('returns a validation error and emits a scan error for invalid scan options', async () => {
    const { mainWindow } = await setup();
    const scanStart = handlers.get('scan:start');

    const response = await scanStart?.({}, { rootPath: '' });
    const result = deserializeIpcResult(response, z.undefined(), 'scan:start');

    expect(Result.isError(result)).toBe(true);
    expect(Result.isError(result) ? result.error._tag : null).toBe('ValidationError');
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('scan:event', {
      type: 'error',
      message: 'Invalid scan options',
    });
  });

  it('remembers the last folder path when opening a folder dialog', async () => {
    const { settingsService } = await setup();
    const openFolderDialog = handlers.get('dialog:open-folder');

    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\incoming'],
    });
    resolveFolderPath.mockResolvedValue(Result.ok('C:\\resolved'));

    await openFolderDialog?.();

    expect(authorizeMediaRoot).toHaveBeenCalledWith('C:\\resolved');
    expect(settingsService.updateSettings).toHaveBeenCalledWith({
      lastFolderPath: 'C:\\resolved',
    });
  });

  it('returns a validation error when revealing an unauthorized media path', async () => {
    await setup();
    const revealInFolder = handlers.get('shell:reveal-in-folder');

    isAuthorizedMediaPath.mockResolvedValue(false);

    const response = await revealInFolder?.({}, 'C:\\blocked\\file.jpg');
    const result = deserializeIpcResult(response, z.undefined(), 'shell:reveal-in-folder');

    expect(Result.isError(result)).toBe(true);
    expect(Result.isError(result) ? result.error._tag : null).toBe('ValidationError');
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('emits a scan error when the catalog service fails to start a scan', async () => {
    const { catalogService, mainWindow } = await setup();
    const scanStart = handlers.get('scan:start');

    resolveFolderPath.mockResolvedValue(Result.ok('C:\\resolved'));
    authorizeMediaRoot.mockResolvedValue(undefined);
    catalogService.startScan.mockResolvedValue(
      Result.err(
        new WorkerError({
          worker: 'catalog',
          operation: 'start-scan',
          message: 'worker crashed',
        }),
      ),
    );

    const response = await scanStart?.(
      {},
      {
        rootPath: 'C:\\resolved',
        recursive: false,
        filters: DEFAULT_SETTINGS.filters,
      },
    );
    const result = deserializeIpcResult(response, z.undefined(), 'scan:start');

    expect(Result.isError(result)).toBe(true);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('scan:event', {
      type: 'error',
      message: 'Scan failed: worker crashed',
    });
  });
});
