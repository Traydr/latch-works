import path from 'node:path';
import { Result, type SerializedResult } from 'better-result';
import type { BrowserWindow, OpenDialogReturnValue } from 'electron';
import { app, dialog, ipcMain, shell } from 'electron';
import type { ZodType } from 'zod';

import { DiagnosticsSnapshotSchema, type JsonValue, PathInputSchema } from '../../shared/contracts';
import { serializeIpcResult } from '../../shared/ipc';
import { InvokeIpcContractList, InvokeIpcContracts } from '../../shared/ipcContracts';
import type { DiagnosticsSnapshot, IpcErrorPayload, ScanEvent } from '../../shared/types';
import type { CatalogService } from '../catalog/CatalogService';
import { parseWithSchema, serializeAppResult, ValidationError } from '../errors';
import { listFolderChildren, resolveFolderPath } from '../services/folderService';
import {
  authorizeMediaRoot,
  clearThumbnailCache,
  getThumbnailDiagnostics,
  getThumbnailWorkerCapabilities,
  isAuthorizedMediaPath,
  setThumbnailDebugOptions,
  shrinkAuthorizedMediaRootsTo,
} from '../services/mediaProtocol';
import type { MediaToolsService } from '../services/mediaToolsService';
import type { SettingsService } from '../services/settingsService';

/** Every invoke handler answers with a serialized better-result envelope. */
type IpcResponseHandler<T> = (
  ...args: JsonValue[]
) => Promise<SerializedResult<T, IpcErrorPayload>>;

/** The parts of the settings, catalog, and media-tools services the IPC layer drives. */
export type IpcSettingsService = Pick<SettingsService, 'getSettings' | 'updateSettings'>;
export type IpcCatalogService = Pick<
  CatalogService,
  'cancelScan' | 'clearIndex' | 'getMediaIndexStats' | 'startScan'
>;
export type IpcMediaToolsService = Pick<MediaToolsService, 'getStatus' | 'probeVideo'>;

/** Everything the IPC layer reaches outside itself: Electron, the folder tree, media access. */
export interface IpcRuntime {
  authorizeMediaRoot: typeof authorizeMediaRoot;
  clearThumbnailCache: typeof clearThumbnailCache;
  getAppVersion: () => string;
  getThumbnailDiagnostics: typeof getThumbnailDiagnostics;
  getThumbnailWorkerCapabilities: typeof getThumbnailWorkerCapabilities;
  handle: <T>(channel: string, handler: IpcResponseHandler<T>) => void;
  isAuthorizedMediaPath: typeof isAuthorizedMediaPath;
  isPackaged: () => boolean;
  isWindowDestroyed: () => boolean;
  listFolderChildren: typeof listFolderChildren;
  removeHandler: (channel: string) => void;
  resolveFolderPath: typeof resolveFolderPath;
  sendScanEvent: (event: ScanEvent) => void;
  setThumbnailDebugOptions: typeof setThumbnailDebugOptions;
  showItemInFolder: (fullPath: string) => void;
  showOpenFolderDialog: () => Promise<OpenDialogReturnValue>;
  shrinkAuthorizedMediaRootsTo: typeof shrinkAuthorizedMediaRootsTo;
}

/** The production runtime: Electron's main-process APIs bound to the app window. */
export function createElectronIpcRuntime(mainWindow: BrowserWindow): IpcRuntime {
  return {
    authorizeMediaRoot,
    clearThumbnailCache,
    getAppVersion: () => app.getVersion(),
    getThumbnailDiagnostics,
    getThumbnailWorkerCapabilities,
    handle: (channel, handler) => {
      ipcMain.handle(channel, (_event, ...args: JsonValue[]) => handler(...args));
    },
    isAuthorizedMediaPath,
    isPackaged: () => app.isPackaged,
    isWindowDestroyed: () => mainWindow.isDestroyed(),
    listFolderChildren,
    removeHandler: (channel) => {
      ipcMain.removeHandler(channel);
    },
    resolveFolderPath,
    sendScanEvent: (event) => {
      mainWindow.webContents.send('scan:event', event);
    },
    setThumbnailDebugOptions,
    showItemInFolder: (fullPath) => {
      shell.showItemInFolder(fullPath);
    },
    showOpenFolderDialog: () =>
      dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Open Folder',
      }),
    shrinkAuthorizedMediaRootsTo,
  };
}

function validationFailure(operation: string, message: string) {
  return serializeAppResult(
    Result.err(
      new ValidationError({
        operation,
        message,
      }),
    ),
  );
}

function okResult<T>(value: T) {
  return serializeIpcResult(Result.ok(value));
}

function validateIpcInput<T>(
  schema: ZodType<T>,
  input: JsonValue,
  channel: string,
): { ok: true; value: T } | { ok: false; serialized: ReturnType<typeof serializeAppResult> } {
  const parsed = parseWithSchema(schema, input, channel);
  if (Result.isError(parsed)) {
    return { ok: false, serialized: serializeAppResult(Result.err(parsed.error)) };
  }

  return { ok: true, value: parsed.value };
}

function requireRequestSchema<T>(schema: ZodType<T> | null): ZodType<T> {
  if (!schema) {
    throw new Error('IPC request schema is not defined for this channel');
  }

  return schema;
}

export function registerIpc(
  runtime: IpcRuntime,
  settingsService: IpcSettingsService,
  catalogService: IpcCatalogService,
  mediaToolsService: IpcMediaToolsService,
): void {
  const channels = InvokeIpcContractList.map((contract) => contract.channel);

  for (const channel of channels) {
    runtime.removeHandler(channel);
  }

  runtime.handle(InvokeIpcContracts.openFolderDialog.channel, async () => {
    const { canceled, filePaths } = await runtime.showOpenFolderDialog();

    if (canceled || filePaths.length === 0) {
      return okResult<string | null>(null);
    }

    const selectedPathResult = await runtime.resolveFolderPath(filePaths[0]);
    if (Result.isError(selectedPathResult)) {
      return serializeAppResult(Result.err(selectedPathResult.error));
    }

    const selectedPath = selectedPathResult.value;
    if (!selectedPath) {
      return okResult<string | null>(null);
    }

    await runtime.authorizeMediaRoot(selectedPath);
    const settings = settingsService.getSettings();
    if (settings.rememberLastFolder) {
      const updateResult = await settingsService.updateSettings({ lastFolderPath: selectedPath });
      if (Result.isError(updateResult)) {
        return serializeAppResult(Result.err(updateResult.error));
      }
    }

    return okResult(selectedPath);
  });

  runtime.handle(InvokeIpcContracts.resolveInputPath.channel, async (candidatePath: JsonValue) => {
    const validated = validateIpcInput(PathInputSchema, candidatePath, 'path:resolve-input');
    if (!validated.ok) {
      return validated.serialized;
    }

    const resolvedPath = await runtime.resolveFolderPath(validated.value);
    if (Result.isError(resolvedPath)) {
      return serializeAppResult(Result.err(resolvedPath.error));
    }

    return okResult(resolvedPath.value);
  });

  runtime.handle(InvokeIpcContracts.startScan.channel, async (options: JsonValue) => {
    const validated = validateIpcInput(
      requireRequestSchema(InvokeIpcContracts.startScan.requestSchema),
      options,
      InvokeIpcContracts.startScan.channel,
    );
    if (!validated.ok) {
      const error = validated.serialized;
      if (!runtime.isWindowDestroyed()) {
        runtime.sendScanEvent({
          type: 'error',
          message: 'Invalid scan options',
        });
      }
      return error;
    }

    const resolvedRootResult = await runtime.resolveFolderPath(validated.value.rootPath);
    if (Result.isError(resolvedRootResult)) {
      return serializeAppResult(Result.err(resolvedRootResult.error));
    }

    const resolvedRoot = resolvedRootResult.value;
    if (!resolvedRoot) {
      runtime.sendScanEvent({
        type: 'error',
        message: 'Invalid folder path',
        path: validated.value.rootPath,
      });
      return validationFailure('scan:start', 'Invalid folder path');
    }

    const settings = settingsService.getSettings();
    let authorized = await runtime.isAuthorizedMediaPath(resolvedRoot);
    // Remembered folders are chosen via the native dialog, then persisted. After a restart the
    // in-memory allowlist is empty — re-authorize the exact remembered path so auto-scan works.
    if (
      !authorized &&
      settings.rememberLastFolder &&
      settings.lastFolderPath &&
      path.resolve(resolvedRoot) === path.resolve(settings.lastFolderPath)
    ) {
      await runtime.authorizeMediaRoot(resolvedRoot);
      authorized = await runtime.isAuthorizedMediaPath(resolvedRoot);
    }
    if (!authorized) {
      if (!runtime.isWindowDestroyed()) {
        runtime.sendScanEvent({
          type: 'error',
          message: 'Folder path is not authorized. Open a folder with the native dialog first.',
          path: resolvedRoot,
        });
      }
      return validationFailure(
        'scan:start',
        'Folder path is not authorized. Open a folder with the native dialog first.',
      );
    }

    await runtime.shrinkAuthorizedMediaRootsTo(resolvedRoot);

    if (settings.rememberLastFolder) {
      const updateResult = await settingsService.updateSettings({ lastFolderPath: resolvedRoot });
      if (Result.isError(updateResult)) {
        return serializeAppResult(Result.err(updateResult.error));
      }
    }

    const excludedRootChildPaths: string[] = [];
    for (const excludedPath of validated.value.excludedRootChildPaths) {
      const resolvedExcludedPath = path.resolve(excludedPath);
      if (path.dirname(resolvedExcludedPath) === resolvedRoot) {
        excludedRootChildPaths.push(resolvedExcludedPath);
      }
    }

    const startResult = await catalogService.startScan({
      ...validated.value,
      rootPath: resolvedRoot,
      excludedRootChildPaths,
    });
    if (Result.isError(startResult)) {
      if (!runtime.isWindowDestroyed()) {
        runtime.sendScanEvent({
          type: 'error',
          message: `Scan failed: ${startResult.error.message}`,
        });
      }

      return serializeAppResult(Result.err(startResult.error));
    }

    return okResult(undefined);
  });

  runtime.handle(InvokeIpcContracts.cancelScan.channel, async () => {
    const cancelResult = await catalogService.cancelScan();
    if (Result.isError(cancelResult)) {
      return serializeAppResult(Result.err(cancelResult.error));
    }

    return okResult(undefined);
  });

  runtime.handle(InvokeIpcContracts.listFolderChildren.channel, async (folderPath: JsonValue) => {
    const validated = validateIpcInput(PathInputSchema, folderPath, 'tree:list-children');
    if (!validated.ok) {
      return validated.serialized;
    }

    const resolvedPathResult = await runtime.resolveFolderPath(validated.value);
    if (Result.isError(resolvedPathResult)) {
      return serializeAppResult(Result.err(resolvedPathResult.error));
    }

    const resolvedPath = resolvedPathResult.value;
    if (!resolvedPath) {
      return validationFailure('tree:list-children', 'Invalid folder path');
    }

    const authorized = await runtime.isAuthorizedMediaPath(resolvedPath);
    if (!authorized) {
      return validationFailure('tree:list-children', 'Folder path is not authorized');
    }

    const childrenResult = await runtime.listFolderChildren(resolvedPath);
    if (Result.isError(childrenResult)) {
      return serializeAppResult(Result.err(childrenResult.error));
    }

    return okResult(childrenResult.value);
  });

  runtime.handle(InvokeIpcContracts.getSettings.channel, async () => {
    return okResult(settingsService.getSettings());
  });

  runtime.handle(InvokeIpcContracts.updateSettings.channel, async (patch: JsonValue) => {
    const validated = validateIpcInput(
      requireRequestSchema(InvokeIpcContracts.updateSettings.requestSchema),
      patch,
      InvokeIpcContracts.updateSettings.channel,
    );
    if (!validated.ok) {
      return validated.serialized;
    }

    const normalizedPatch = {
      ...validated.value,
      lastFolderPath:
        validated.value.lastFolderPath === undefined || validated.value.lastFolderPath === null
          ? validated.value.lastFolderPath
          : path.resolve(validated.value.lastFolderPath),
    };

    const updatedSettings = await settingsService.updateSettings(normalizedPatch);
    if (Result.isError(updatedSettings)) {
      return serializeAppResult(Result.err(updatedSettings.error));
    }

    runtime.setThumbnailDebugOptions(updatedSettings.value.debug);
    return okResult(updatedSettings.value);
  });

  runtime.handle(InvokeIpcContracts.revealInFolder.channel, async (filePath: JsonValue) => {
    const validated = validateIpcInput(PathInputSchema, filePath, 'shell:reveal-in-folder');
    if (!validated.ok) {
      return validated.serialized;
    }

    const resolvedPath = path.resolve(validated.value);
    const authorized = await runtime.isAuthorizedMediaPath(resolvedPath);
    if (!authorized) {
      return validationFailure('shell:reveal-in-folder', 'Media path is not authorized');
    }

    runtime.showItemInFolder(resolvedPath);
    return okResult(undefined);
  });

  runtime.handle(InvokeIpcContracts.probeVideoMetadata.channel, async (request: JsonValue) => {
    const validated = validateIpcInput(
      requireRequestSchema(InvokeIpcContracts.probeVideoMetadata.requestSchema),
      request,
      InvokeIpcContracts.probeVideoMetadata.channel,
    );
    if (!validated.ok) {
      return validated.serialized;
    }

    const sanitizedRequest = {
      ...validated.value,
      path: path.resolve(validated.value.path),
    };

    const authorized = await runtime.isAuthorizedMediaPath(sanitizedRequest.path);
    if (!authorized) {
      return validationFailure('media:probe-video', 'Media path is not authorized');
    }

    return okResult(
      await mediaToolsService.probeVideo(
        sanitizedRequest.path,
        sanitizedRequest.mtimeMs,
        sanitizedRequest.size,
      ),
    );
  });

  runtime.handle(InvokeIpcContracts.clearThumbnailCache.channel, async () => {
    await runtime.clearThumbnailCache();
    return okResult(undefined);
  });

  runtime.handle(InvokeIpcContracts.getMediaIndexStats.channel, async () => {
    const statsResult = await catalogService.getMediaIndexStats();
    if (Result.isError(statsResult)) {
      return serializeAppResult(Result.err(statsResult.error));
    }

    return okResult(statsResult.value);
  });

  runtime.handle(InvokeIpcContracts.clearMediaIndex.channel, async () => {
    const clearResult = await catalogService.clearIndex();
    if (Result.isError(clearResult)) {
      return serializeAppResult(Result.err(clearResult.error));
    }

    return okResult(undefined);
  });

  runtime.handle(InvokeIpcContracts.getMediaToolsStatus.channel, async () => {
    return okResult(mediaToolsService.getStatus());
  });

  runtime.handle(InvokeIpcContracts.getDiagnosticsSnapshot.channel, async () => {
    const thumbnailDiagnostics = runtime.getThumbnailDiagnostics();
    const thumbnailWorker = runtime.getThumbnailWorkerCapabilities();
    const settings = settingsService.getSettings();

    const diagnostics: DiagnosticsSnapshot = {
      appVersion: runtime.getAppVersion(),
      arch: process.arch,
      currentFolder: null,
      debug: settings.debug,
      electronVersion: process.versions.electron,
      isPackaged: runtime.isPackaged(),
      mediaTools: mediaToolsService.getStatus(),
      platform: process.platform,
      thumbnails: thumbnailDiagnostics ?? {
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
      thumbnailWorker,
      thumbnailWorkerPerformance: thumbnailDiagnostics?.timings ?? null,
    };

    const parsedDiagnostics = DiagnosticsSnapshotSchema.safeParse(diagnostics);
    if (!parsedDiagnostics.success) {
      return validationFailure('debug:get-diagnostics', 'Invalid diagnostics snapshot');
    }

    return okResult(parsedDiagnostics.data);
  });
}
