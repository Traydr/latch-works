import type { ZodType } from 'zod';

import { AppCommandSchema, type JsonValue, ScanEventSchema } from '../shared/contracts';
import { deserializeIpcResult } from '../shared/ipc';
import { InvokeIpcContracts } from '../shared/ipcContracts';
import type {
  AppCommand,
  AppSettingsPatch,
  FrameViewApi,
  ScanEvent,
  ScanOptions,
  VideoProbeRequest,
} from '../shared/types';

/**
 * The renderer-side IPC transport the bridge needs: request/response invokes and channel
 * subscriptions that hand back their own unsubscribe.
 */
export interface PreloadIpcTransport {
  invoke: (channel: string, ...args: JsonValue[]) => Promise<JsonValue>;
  subscribe: (channel: string, listener: (payload: JsonValue) => void) => () => void;
}

/** Builds the `window.frameView` bridge over a renderer IPC transport. */
export function createFrameViewApi(transport: PreloadIpcTransport): FrameViewApi {
  function invokeResult<T>(
    channel: string,
    schema: ZodType<T>,
    ...args: JsonValue[]
  ): Promise<ReturnType<typeof deserializeIpcResult<T>>> {
    return transport
      .invoke(channel, ...args)
      .then((value) => deserializeIpcResult(value, schema, channel));
  }

  return {
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
    onAppCommand: (listener: (command: AppCommand) => void) =>
      transport.subscribe('app:command', (payload) => {
        const parsedPayload = AppCommandSchema.safeParse(payload);
        if (parsedPayload.success) {
          listener(parsedPayload.data);
        }
      }),
    onScanEvent: (listener: (event: ScanEvent) => void) =>
      transport.subscribe('scan:event', (payload) => {
        const parsedPayload = ScanEventSchema.safeParse(payload);
        if (parsedPayload.success) {
          listener(parsedPayload.data);
        }
      }),
  };
}
