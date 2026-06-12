import path from 'node:path';
import { Result } from 'better-result';
import type { BrowserWindow } from 'electron';
import { app, dialog, ipcMain, shell } from 'electron';
import type { ZodType } from 'zod';

import { DiagnosticsSnapshotSchema, PathInputSchema } from '../../shared/contracts';
import { serializeIpcResult } from '../../shared/ipc';
import { InvokeIpcContractList, InvokeIpcContracts } from '../../shared/ipcContracts';
import type { DiagnosticsSnapshot } from '../../shared/types';
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
} from '../services/mediaProtocol';
import type { MediaToolsService } from '../services/mediaToolsService';
import type { SettingsService } from '../services/settingsService';

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
  input: unknown,
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
  mainWindow: BrowserWindow,
  settingsService: SettingsService,
  catalogService: CatalogService,
  mediaToolsService: MediaToolsService,
): void {
  const channels = InvokeIpcContractList.map((contract) => contract.channel);

  for (const channel of channels) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle(InvokeIpcContracts.openFolderDialog.channel, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Open Folder',
    });

    if (canceled || filePaths.length === 0) {
      return okResult<string | null>(null);
    }

    const selectedPathResult = await resolveFolderPath(filePaths[0]);
    if (Result.isError(selectedPathResult)) {
      return serializeAppResult(Result.err(selectedPathResult.error));
    }

    const selectedPath = selectedPathResult.value;
    if (!selectedPath) {
      return okResult<string | null>(null);
    }

    await authorizeMediaRoot(selectedPath);
    const settings = settingsService.getSettings();
    if (settings.rememberLastFolder) {
      const updateResult = await settingsService.updateSettings({ lastFolderPath: selectedPath });
      if (Result.isError(updateResult)) {
        return serializeAppResult(Result.err(updateResult.error));
      }
    }

    return okResult(selectedPath);
  });

  ipcMain.handle(
    InvokeIpcContracts.resolveInputPath.channel,
    async (_event, candidatePath: unknown) => {
      const validated = validateIpcInput(PathInputSchema, candidatePath, 'path:resolve-input');
      if (!validated.ok) {
        return validated.serialized;
      }

      const resolvedPath = await resolveFolderPath(validated.value);
      if (Result.isError(resolvedPath)) {
        return serializeAppResult(Result.err(resolvedPath.error));
      }

      return okResult(resolvedPath.value);
    },
  );

  ipcMain.handle(InvokeIpcContracts.startScan.channel, async (_event, options: unknown) => {
    const validated = validateIpcInput(
      requireRequestSchema(InvokeIpcContracts.startScan.requestSchema),
      options,
      InvokeIpcContracts.startScan.channel,
    );
    if (!validated.ok) {
      const error = validated.serialized;
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan:event', {
          type: 'error',
          message: 'Invalid scan options',
        });
      }
      return error;
    }

    const resolvedRootResult = await resolveFolderPath(validated.value.rootPath);
    if (Result.isError(resolvedRootResult)) {
      return serializeAppResult(Result.err(resolvedRootResult.error));
    }

    const resolvedRoot = resolvedRootResult.value;
    if (!resolvedRoot) {
      mainWindow.webContents.send('scan:event', {
        type: 'error',
        message: 'Invalid folder path',
        path: validated.value.rootPath,
      });
      return validationFailure('scan:start', 'Invalid folder path');
    }

    await authorizeMediaRoot(resolvedRoot);

    const settings = settingsService.getSettings();
    if (settings.rememberLastFolder) {
      const updateResult = await settingsService.updateSettings({ lastFolderPath: resolvedRoot });
      if (Result.isError(updateResult)) {
        return serializeAppResult(Result.err(updateResult.error));
      }
    }

    const startResult = await catalogService.startScan({
      ...validated.value,
      rootPath: resolvedRoot,
      excludedRootChildPaths: validated.value.excludedRootChildPaths
        .map((excludedPath) => path.resolve(excludedPath))
        .filter((excludedPath) => path.dirname(excludedPath) === resolvedRoot),
    });
    if (Result.isError(startResult)) {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan:event', {
          type: 'error',
          message: `Scan failed: ${startResult.error.message}`,
        });
      }

      return serializeAppResult(Result.err(startResult.error));
    }

    return okResult(undefined);
  });

  ipcMain.handle(InvokeIpcContracts.cancelScan.channel, async () => {
    const cancelResult = await catalogService.cancelScan();
    if (Result.isError(cancelResult)) {
      return serializeAppResult(Result.err(cancelResult.error));
    }

    return okResult(undefined);
  });

  ipcMain.handle(
    InvokeIpcContracts.listFolderChildren.channel,
    async (_event, folderPath: unknown) => {
      const validated = validateIpcInput(PathInputSchema, folderPath, 'tree:list-children');
      if (!validated.ok) {
        return validated.serialized;
      }

      const resolvedPathResult = await resolveFolderPath(validated.value);
      if (Result.isError(resolvedPathResult)) {
        return serializeAppResult(Result.err(resolvedPathResult.error));
      }

      const resolvedPath = resolvedPathResult.value;
      if (!resolvedPath) {
        return validationFailure('tree:list-children', 'Invalid folder path');
      }

      const authorized = await isAuthorizedMediaPath(resolvedPath);
      if (!authorized) {
        return validationFailure('tree:list-children', 'Folder path is not authorized');
      }

      const childrenResult = await listFolderChildren(resolvedPath);
      if (Result.isError(childrenResult)) {
        return serializeAppResult(Result.err(childrenResult.error));
      }

      return okResult(childrenResult.value);
    },
  );

  ipcMain.handle(InvokeIpcContracts.getSettings.channel, async () => {
    return okResult(settingsService.getSettings());
  });

  ipcMain.handle(InvokeIpcContracts.updateSettings.channel, async (_event, patch: unknown) => {
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

    setThumbnailDebugOptions(updatedSettings.value.debug);
    return okResult(updatedSettings.value);
  });

  ipcMain.handle(InvokeIpcContracts.revealInFolder.channel, async (_event, filePath: unknown) => {
    const validated = validateIpcInput(PathInputSchema, filePath, 'shell:reveal-in-folder');
    if (!validated.ok) {
      return validated.serialized;
    }

    const resolvedPath = path.resolve(validated.value);
    const authorized = await isAuthorizedMediaPath(resolvedPath);
    if (!authorized) {
      return validationFailure('shell:reveal-in-folder', 'Media path is not authorized');
    }

    shell.showItemInFolder(resolvedPath);
    return okResult(undefined);
  });

  ipcMain.handle(
    InvokeIpcContracts.probeVideoMetadata.channel,
    async (_event, request: unknown) => {
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

      const authorized = await isAuthorizedMediaPath(sanitizedRequest.path);
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
    },
  );

  ipcMain.handle(InvokeIpcContracts.clearThumbnailCache.channel, async () => {
    await clearThumbnailCache();
    return okResult(undefined);
  });

  ipcMain.handle(InvokeIpcContracts.getMediaIndexStats.channel, async () => {
    const statsResult = await catalogService.getMediaIndexStats();
    if (Result.isError(statsResult)) {
      return serializeAppResult(Result.err(statsResult.error));
    }

    return okResult(statsResult.value);
  });

  ipcMain.handle(InvokeIpcContracts.clearMediaIndex.channel, async () => {
    const clearResult = await catalogService.clearIndex();
    if (Result.isError(clearResult)) {
      return serializeAppResult(Result.err(clearResult.error));
    }

    return okResult(undefined);
  });

  ipcMain.handle(InvokeIpcContracts.getMediaToolsStatus.channel, async () => {
    return okResult(mediaToolsService.getStatus());
  });

  ipcMain.handle(InvokeIpcContracts.getDiagnosticsSnapshot.channel, async () => {
    const thumbnailDiagnostics = getThumbnailDiagnostics();
    const thumbnailWorker = getThumbnailWorkerCapabilities();
    const settings = settingsService.getSettings();

    const diagnostics: DiagnosticsSnapshot = {
      appVersion: app.getVersion(),
      arch: process.arch,
      currentFolder: null,
      debug: settings.debug,
      electronVersion: process.versions.electron,
      isPackaged: app.isPackaged,
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
