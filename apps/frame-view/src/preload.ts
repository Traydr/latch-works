import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer } from 'electron';
import type { ZodType } from 'zod';

import { AppCommandSchema, ScanEventSchema } from './shared/contracts';
import { deserializeIpcResult } from './shared/ipc';
import { InvokeIpcContracts } from './shared/ipcContracts';
import type {
  AppCommand,
  AppSettingsPatch,
  FrameViewApi,
  ScanEvent,
  ScanOptions,
  VideoProbeRequest,
} from './shared/types';

function invokeResult<T>(
  channel: string,
  schema: ZodType<T>,
  ...args: unknown[]
): Promise<ReturnType<typeof deserializeIpcResult<T>>> {
  return ipcRenderer
    .invoke(channel, ...args)
    .then((value) => deserializeIpcResult(value, schema, channel));
}

const api: FrameViewApi = {
  openFolderDialog: () =>
    invokeResult(
      InvokeIpcContracts.openFolderDialog.channel,
      InvokeIpcContracts.openFolderDialog.responseSchema,
    ),
  resolveInputPath: (candidatePath: string) =>
    invokeResult(
      InvokeIpcContracts.resolveInputPath.channel,
      InvokeIpcContracts.resolveInputPath.responseSchema,
      candidatePath,
    ),
  startScan: (options: ScanOptions) =>
    invokeResult(
      InvokeIpcContracts.startScan.channel,
      InvokeIpcContracts.startScan.responseSchema,
      options,
    ),
  cancelScan: () =>
    invokeResult(
      InvokeIpcContracts.cancelScan.channel,
      InvokeIpcContracts.cancelScan.responseSchema,
    ),
  listFolderChildren: (folderPath: string) =>
    invokeResult(
      InvokeIpcContracts.listFolderChildren.channel,
      InvokeIpcContracts.listFolderChildren.responseSchema,
      folderPath,
    ),
  getSettings: () =>
    invokeResult(
      InvokeIpcContracts.getSettings.channel,
      InvokeIpcContracts.getSettings.responseSchema,
    ),
  updateSettings: (patch: AppSettingsPatch) =>
    invokeResult(
      InvokeIpcContracts.updateSettings.channel,
      InvokeIpcContracts.updateSettings.responseSchema,
      patch,
    ),
  revealInFolder: (filePath: string) =>
    invokeResult(
      InvokeIpcContracts.revealInFolder.channel,
      InvokeIpcContracts.revealInFolder.responseSchema,
      filePath,
    ),
  probeVideoMetadata: (request: VideoProbeRequest) =>
    invokeResult(
      InvokeIpcContracts.probeVideoMetadata.channel,
      InvokeIpcContracts.probeVideoMetadata.responseSchema,
      request,
    ),
  clearThumbnailCache: () =>
    invokeResult(
      InvokeIpcContracts.clearThumbnailCache.channel,
      InvokeIpcContracts.clearThumbnailCache.responseSchema,
    ),
  getMediaIndexStats: () =>
    invokeResult(
      InvokeIpcContracts.getMediaIndexStats.channel,
      InvokeIpcContracts.getMediaIndexStats.responseSchema,
    ),
  clearMediaIndex: () =>
    invokeResult(
      InvokeIpcContracts.clearMediaIndex.channel,
      InvokeIpcContracts.clearMediaIndex.responseSchema,
    ),
  getMediaToolsStatus: () =>
    invokeResult(
      InvokeIpcContracts.getMediaToolsStatus.channel,
      InvokeIpcContracts.getMediaToolsStatus.responseSchema,
    ),
  debug: {
    getDiagnosticsSnapshot: () =>
      invokeResult(
        InvokeIpcContracts.getDiagnosticsSnapshot.channel,
        InvokeIpcContracts.getDiagnosticsSnapshot.responseSchema,
      ),
  },
  onAppCommand: (listener: (command: AppCommand) => void) => {
    const wrappedListener = (_event: IpcRendererEvent, payload: unknown) => {
      const parsedPayload = AppCommandSchema.safeParse(payload);
      if (parsedPayload.success) {
        listener(parsedPayload.data);
      }
    };

    ipcRenderer.on('app:command', wrappedListener);
    return () => {
      ipcRenderer.removeListener('app:command', wrappedListener);
    };
  },
  onScanEvent: (listener: (event: ScanEvent) => void) => {
    const wrappedListener = (_event: IpcRendererEvent, payload: unknown) => {
      const parsedPayload = ScanEventSchema.safeParse(payload);
      if (parsedPayload.success) {
        listener(parsedPayload.data);
      }
    };

    ipcRenderer.on('scan:event', wrappedListener);

    return () => {
      ipcRenderer.removeListener('scan:event', wrappedListener);
    };
  },
};

contextBridge.exposeInMainWorld('frameView', api);
