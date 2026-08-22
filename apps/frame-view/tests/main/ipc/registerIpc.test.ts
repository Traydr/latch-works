import { Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';

import { WorkerError } from '../../../src/main/errors';
import {
  type IpcCatalogService,
  type IpcMediaToolsService,
  type IpcRuntime,
  type IpcSettingsService,
  registerIpc,
} from '../../../src/main/ipc/registerIpc';
import type { AppSettingsPatch } from '../../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../../src/shared/types';

type RegisteredHandler = Parameters<IpcRuntime['handle']>[1];

const MEDIA_TOOLS_STATUS = {
  ffmpegAvailable: true,
  ffprobeAvailable: true,
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
};

function setup() {
  const handlers = new Map<string, RegisteredHandler>();

  const authorizeMediaRoot = vi.fn<IpcRuntime['authorizeMediaRoot']>(async () => undefined);
  const isAuthorizedMediaPath = vi.fn<IpcRuntime['isAuthorizedMediaPath']>(async () => true);
  const listFolderChildren = vi.fn<IpcRuntime['listFolderChildren']>(async () => Result.ok([]));
  const resolveFolderPath = vi.fn<IpcRuntime['resolveFolderPath']>(async () => Result.ok(null));
  const sendScanEvent = vi.fn<IpcRuntime['sendScanEvent']>();
  const showItemInFolder = vi.fn<IpcRuntime['showItemInFolder']>();
  const showOpenFolderDialog = vi.fn<IpcRuntime['showOpenFolderDialog']>(async () => ({
    canceled: true,
    filePaths: [],
  }));
  const shrinkAuthorizedMediaRootsTo = vi.fn<IpcRuntime['shrinkAuthorizedMediaRootsTo']>(
    async () => undefined,
  );

  const runtime: IpcRuntime = {
    authorizeMediaRoot,
    clearThumbnailCache: vi.fn<IpcRuntime['clearThumbnailCache']>(async () => undefined),
    getAppVersion: () => '1.0.13',
    getThumbnailDiagnostics: () => null,
    getThumbnailWorkerCapabilities: () => null,
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    isAuthorizedMediaPath,
    isPackaged: () => false,
    isWindowDestroyed: () => false,
    listFolderChildren,
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
    resolveFolderPath,
    sendScanEvent,
    setThumbnailDebugOptions: vi.fn<IpcRuntime['setThumbnailDebugOptions']>(),
    showItemInFolder,
    showOpenFolderDialog,
    shrinkAuthorizedMediaRootsTo,
  };

  const settingsService = {
    getSettings: vi.fn<IpcSettingsService['getSettings']>(() => DEFAULT_SETTINGS),
    updateSettings: vi.fn<IpcSettingsService['updateSettings']>(async (patch: AppSettingsPatch) =>
      Result.ok({
        ...DEFAULT_SETTINGS,
        lastFolderPath: patch.lastFolderPath ?? DEFAULT_SETTINGS.lastFolderPath,
      }),
    ),
  } satisfies IpcSettingsService;

  const catalogService = {
    cancelScan: vi.fn<IpcCatalogService['cancelScan']>(async () => Result.ok(undefined)),
    clearIndex: vi.fn<IpcCatalogService['clearIndex']>(async () => Result.ok(undefined)),
    getMediaIndexStats: vi.fn<IpcCatalogService['getMediaIndexStats']>(async () =>
      Result.ok({
        totalItems: 0,
        uniqueRoots: 0,
        dbPath: 'index.sqlite',
      }),
    ),
    startScan: vi.fn<IpcCatalogService['startScan']>(async () => Result.ok(undefined)),
  } satisfies IpcCatalogService;

  const mediaToolsService = {
    getStatus: vi.fn<IpcMediaToolsService['getStatus']>(() => MEDIA_TOOLS_STATUS),
    probeVideo: vi.fn<IpcMediaToolsService['probeVideo']>(async () => null),
  } satisfies IpcMediaToolsService;

  registerIpc(runtime, settingsService, catalogService, mediaToolsService);

  return {
    authorizeMediaRoot,
    catalogService,
    handlers,
    isAuthorizedMediaPath,
    listFolderChildren,
    resolveFolderPath,
    sendScanEvent,
    settingsService,
    showItemInFolder,
    showOpenFolderDialog,
    shrinkAuthorizedMediaRootsTo,
  };
}

describe('registerIpc', () => {
  it('returns a validation error and emits a scan error for invalid scan options', async () => {
    const { handlers, sendScanEvent } = setup();

    const response = await handlers.get('scan:start')?.({ rootPath: '' });

    expect(response?.status).toBe('error');
    expect(response?.status === 'error' ? response.error._tag : null).toBe('ValidationError');
    expect(sendScanEvent).toHaveBeenCalledWith({
      type: 'error',
      message: 'Invalid scan options',
    });
  });

  it('forwards settings patches without injecting keys the renderer did not send', async () => {
    const { handlers, settingsService } = setup();

    const response = await handlers.get('settings:update')?.({ sortMode: 'random' });

    expect(response?.status).toBe('ok');
    expect(settingsService.updateSettings).toHaveBeenCalledTimes(1);
    const forwardedPatch = settingsService.updateSettings.mock.calls[0]?.[0];
    expect(forwardedPatch).toEqual({ sortMode: 'random' });
    expect(Object.keys(forwardedPatch ?? {})).toEqual(['sortMode']);
  });

  it('remembers the last folder path when opening a folder dialog', async () => {
    const {
      authorizeMediaRoot,
      handlers,
      resolveFolderPath,
      settingsService,
      showOpenFolderDialog,
    } = setup();

    showOpenFolderDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\incoming'],
    });
    resolveFolderPath.mockResolvedValue(Result.ok('C:\\resolved'));

    await handlers.get('dialog:open-folder')?.();

    expect(authorizeMediaRoot).toHaveBeenCalledWith('C:\\resolved');
    expect(settingsService.updateSettings).toHaveBeenCalledWith({
      lastFolderPath: 'C:\\resolved',
    });
  });

  it('returns a validation error when listing children for an unauthorized folder', async () => {
    const { handlers, isAuthorizedMediaPath, listFolderChildren, resolveFolderPath } = setup();

    resolveFolderPath.mockResolvedValue(Result.ok('C:\\blocked'));
    isAuthorizedMediaPath.mockResolvedValue(false);

    const response = await handlers.get('tree:list-children')?.('C:\\blocked');

    expect(response?.status).toBe('error');
    expect(response?.status === 'error' ? response.error._tag : null).toBe('ValidationError');
    expect(listFolderChildren).not.toHaveBeenCalled();
  });

  it('lists children for authorized folders', async () => {
    const { handlers, isAuthorizedMediaPath, listFolderChildren, resolveFolderPath } = setup();

    resolveFolderPath.mockResolvedValue(Result.ok('C:\\authorized'));
    isAuthorizedMediaPath.mockResolvedValue(true);
    listFolderChildren.mockResolvedValue(
      Result.ok([{ path: 'C:\\authorized\\child', name: 'child', hasChildren: false }]),
    );

    const response = await handlers.get('tree:list-children')?.('C:\\authorized');

    expect(response?.status).toBe('ok');
    expect(listFolderChildren).toHaveBeenCalledWith('C:\\authorized');
  });

  it('returns a validation error when revealing an unauthorized media path', async () => {
    const { handlers, isAuthorizedMediaPath, showItemInFolder } = setup();

    isAuthorizedMediaPath.mockResolvedValue(false);

    const response = await handlers.get('shell:reveal-in-folder')?.('C:\\blocked\\file.jpg');

    expect(response?.status).toBe('error');
    expect(response?.status === 'error' ? response.error._tag : null).toBe('ValidationError');
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('rejects scan starts for paths that were not authorized via the folder dialog', async () => {
    const {
      authorizeMediaRoot,
      catalogService,
      handlers,
      isAuthorizedMediaPath,
      resolveFolderPath,
      sendScanEvent,
      shrinkAuthorizedMediaRootsTo,
    } = setup();

    resolveFolderPath.mockResolvedValue(Result.ok('C:\\untrusted'));
    isAuthorizedMediaPath.mockResolvedValue(false);

    const response = await handlers.get('scan:start')?.({
      rootPath: 'C:\\untrusted',
      recursive: false,
      filters: DEFAULT_SETTINGS.filters,
    });

    expect(response?.status).toBe('error');
    expect(response?.status === 'error' ? response.error._tag : null).toBe('ValidationError');
    expect(authorizeMediaRoot).not.toHaveBeenCalled();
    expect(shrinkAuthorizedMediaRootsTo).not.toHaveBeenCalled();
    expect(catalogService.startScan).not.toHaveBeenCalled();
    expect(sendScanEvent).toHaveBeenCalledWith({
      type: 'error',
      message: 'Folder path is not authorized. Open a folder with the native dialog first.',
      path: 'C:\\untrusted',
    });
  });

  it('re-authorizes the remembered last folder so auto-scan works after restart', async () => {
    const rememberedPath = 'C:\\gallery';
    const {
      authorizeMediaRoot,
      catalogService,
      handlers,
      isAuthorizedMediaPath,
      resolveFolderPath,
      settingsService,
      shrinkAuthorizedMediaRootsTo,
    } = setup();

    settingsService.getSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      rememberLastFolder: true,
      lastFolderPath: rememberedPath,
    });
    resolveFolderPath.mockResolvedValue(Result.ok(rememberedPath));
    isAuthorizedMediaPath.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const response = await handlers.get('scan:start')?.({
      rootPath: rememberedPath,
      recursive: false,
      filters: DEFAULT_SETTINGS.filters,
      excludedRootChildPaths: [],
    });

    expect(response?.status).toBe('ok');
    expect(authorizeMediaRoot).toHaveBeenCalledWith(rememberedPath);
    expect(shrinkAuthorizedMediaRootsTo).toHaveBeenCalledWith(rememberedPath);
    expect(catalogService.startScan).toHaveBeenCalled();
  });

  it('emits a scan error when the catalog service fails to start a scan', async () => {
    const {
      authorizeMediaRoot,
      catalogService,
      handlers,
      isAuthorizedMediaPath,
      resolveFolderPath,
      sendScanEvent,
      shrinkAuthorizedMediaRootsTo,
    } = setup();

    resolveFolderPath.mockResolvedValue(Result.ok('C:\\resolved'));
    isAuthorizedMediaPath.mockResolvedValue(true);
    catalogService.startScan.mockResolvedValue(
      Result.err(
        new WorkerError({
          worker: 'catalog',
          operation: 'start-scan',
          message: 'worker crashed',
        }),
      ),
    );

    const response = await handlers.get('scan:start')?.({
      rootPath: 'C:\\resolved',
      recursive: false,
      filters: DEFAULT_SETTINGS.filters,
    });

    expect(response?.status).toBe('error');
    expect(authorizeMediaRoot).not.toHaveBeenCalled();
    expect(shrinkAuthorizedMediaRootsTo).toHaveBeenCalledWith('C:\\resolved');
    expect(sendScanEvent).toHaveBeenCalledWith({
      type: 'error',
      message: 'Scan failed: worker crashed',
    });
  });
});
