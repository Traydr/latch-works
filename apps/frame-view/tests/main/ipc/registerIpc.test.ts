import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';

import { ScanQueue } from '../../../src/main/catalog/ScanQueue';
import { WorkerError } from '../../../src/main/errors';
import {
  type IpcCatalogService,
  type IpcMediaToolsService,
  type IpcRuntime,
  type IpcSettingsService,
  registerIpc,
} from '../../../src/main/ipc/registerIpc';
import { resolveFolderPath as resolveRealFolderPath } from '../../../src/main/services/folderService';
import {
  authorizeMediaRoot as authorizeRealMediaRoot,
  claimChosenMediaRoot as claimRealChosenMediaRoot,
  grantChosenMediaRoot as grantRealChosenMediaRoot,
  isAuthorizedMediaPath as isRealAuthorizedMediaPath,
  shrinkAuthorizedMediaRootsTo as shrinkRealAuthorizedMediaRootsTo,
} from '../../../src/main/services/mediaProtocol';
import type { AppSettingsPatch } from '../../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../../src/shared/types';

type RegisteredHandler = Parameters<IpcRuntime['handle']>[1];

const MEDIA_TOOLS_STATUS = {
  ffmpegAvailable: true,
  ffprobeAvailable: true,
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
};

interface SetupOptions {
  /** Real implementations to use in place of the mocked runtime entries. */
  runtime?: Partial<IpcRuntime>;
  waitForScan?: () => Promise<void>;
}

function setup({
  runtime: runtimeOverrides,
  waitForScan = async () => undefined,
}: SetupOptions = {}) {
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

  const claimChosenMediaRoot = vi.fn<IpcRuntime['claimChosenMediaRoot']>(async () => false);
  const grantChosenMediaRoot = vi.fn<IpcRuntime['grantChosenMediaRoot']>(async () => undefined);

  const runtime: IpcRuntime = {
    authorizeMediaRoot,
    claimChosenMediaRoot,
    clearThumbnailCache: vi.fn<IpcRuntime['clearThumbnailCache']>(async () => undefined),
    getAppVersion: () => '1.0.13',
    getThumbnailDiagnostics: () => null,
    getThumbnailWorkerCapabilities: () => null,
    grantChosenMediaRoot,
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
    ...runtimeOverrides,
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

  registerIpc(
    runtime,
    settingsService,
    catalogService,
    mediaToolsService,
    new ScanQueue({
      cancelScan: async () => {
        await catalogService.cancelScan();
      },
      waitForScan,
    }),
  );

  return {
    authorizeMediaRoot,
    catalogService,
    claimChosenMediaRoot,
    grantChosenMediaRoot,
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
      grantChosenMediaRoot,
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

    expect(grantChosenMediaRoot).toHaveBeenCalledWith('C:\\resolved');
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

  it('cancels a running scan for a queued launch folder and claims it once that scan ended', async () => {
    let endScan: () => void = () => undefined;

    const {
      catalogService,
      claimChosenMediaRoot,
      handlers,
      isAuthorizedMediaPath,
      resolveFolderPath,
    } = setup({
      waitForScan: () =>
        new Promise<void>((resolve) => {
          endScan = resolve;
        }),
    });

    resolveFolderPath.mockImplementation(async (folderPath) => Result.ok(folderPath));
    // The launch folder is only scannable through its grant: another scan shrank the roots.
    claimChosenMediaRoot.mockImplementation(async (folderPath) => folderPath === '/opened');
    isAuthorizedMediaPath.mockImplementation(async (folderPath) => folderPath !== '/opened');

    const scanFolder = (rootPath: string) =>
      handlers.get('scan:start')?.({
        rootPath,
        recursive: false,
        filters: DEFAULT_SETTINGS.filters,
      });

    await expect(scanFolder('/remembered')).resolves.toMatchObject({ status: 'ok' });

    const stale = scanFolder('/stale');
    const opened = scanFolder('/opened');

    await expect(stale).resolves.toMatchObject({ status: 'ok' });
    expect(catalogService.cancelScan).toHaveBeenCalled();
    // The cancelled scan is still winding down: the launch folder keeps its grant until it ends.
    expect(claimChosenMediaRoot).not.toHaveBeenCalledWith('/opened');

    endScan();

    await expect(opened).resolves.toMatchObject({ status: 'ok' });
    expect(claimChosenMediaRoot).toHaveBeenCalledWith('/opened');
    expect(catalogService.startScan.mock.calls.map(([options]) => options.rootPath)).toEqual([
      '/remembered',
      '/opened',
    ]);
  });

  it('scans an Open pick made just before an OS open, with no authorization error', async () => {
    const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frame-view-ipc-')));
    const picked = await mkdtemp(path.join(tempRoot, 'picked-'));
    const opened = await mkdtemp(path.join(tempRoot, 'opened-'));
    let running = Promise.resolve();
    let endScan: () => void = () => undefined;

    const { catalogService, handlers, sendScanEvent, showOpenFolderDialog } = setup({
      runtime: {
        authorizeMediaRoot: authorizeRealMediaRoot,
        claimChosenMediaRoot: claimRealChosenMediaRoot,
        grantChosenMediaRoot: grantRealChosenMediaRoot,
        isAuthorizedMediaPath: isRealAuthorizedMediaPath,
        resolveFolderPath: resolveRealFolderPath,
        shrinkAuthorizedMediaRootsTo: shrinkRealAuthorizedMediaRootsTo,
      },
      waitForScan: () => running,
    });

    // A started scan runs until it is cancelled.
    catalogService.startScan.mockImplementation(async () => {
      running = new Promise<void>((resolve) => {
        endScan = resolve;
      });

      return Result.ok(undefined);
    });
    catalogService.cancelScan.mockImplementation(async () => {
      endScan();

      return Result.ok(undefined);
    });

    const scanFolder = (rootPath: string) =>
      handlers.get('scan:start')?.({
        rootPath,
        recursive: false,
        filters: DEFAULT_SETTINGS.filters,
      });

    showOpenFolderDialog.mockResolvedValue({ canceled: false, filePaths: [picked] });
    await handlers.get('dialog:open-folder')?.();
    // Milliseconds later the OS opens another folder (what `openLaunchPath` does), and its scan
    // request reaches the main process first, shrinking the roots to that folder.
    await grantRealChosenMediaRoot(opened);
    await expect(scanFolder(opened)).resolves.toMatchObject({ status: 'ok' });
    await expect(scanFolder(picked)).resolves.toMatchObject({ status: 'ok' });

    expect(sendScanEvent).not.toHaveBeenCalled();
    expect(catalogService.cancelScan).toHaveBeenCalled();
    expect(catalogService.startScan.mock.calls.map(([options]) => options.rootPath)).toEqual([
      opened,
      picked,
    ]);
    expect(await isRealAuthorizedMediaPath(picked)).toBe(true);
    expect(await isRealAuthorizedMediaPath(opened)).toBe(false);
  });
});
