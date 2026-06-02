import { z } from 'zod';

import {
  AppSettingsPatchSchema,
  AppSettingsSchema,
  DiagnosticsSnapshotSchema,
  FolderNodeSchema,
  MediaIndexStatsSchema,
  MediaToolsStatusSchema,
  PathInputSchema,
  ScanOptionsSchema,
  VideoProbeMetadataSchema,
  VideoProbeRequestSchema,
} from './contracts';

const VoidSchema = z.undefined();

function defineInvokeContract<
  const TChannel extends string,
  TArgs extends z.ZodTuple,
  TResponse,
  TRequest = never,
>(
  channel: TChannel,
  argsSchema: TArgs,
  responseSchema: z.ZodType<TResponse>,
  requestSchema: z.ZodType<TRequest> | null = null,
) {
  return {
    argsSchema,
    channel,
    requestSchema,
    responseSchema,
  };
}

export const InvokeIpcContracts = {
  openFolderDialog: defineInvokeContract(
    'dialog:open-folder',
    z.tuple([]),
    PathInputSchema.nullable(),
  ),
  resolveInputPath: defineInvokeContract(
    'path:resolve-input',
    z.tuple([PathInputSchema]),
    PathInputSchema.nullable(),
    PathInputSchema,
  ),
  startScan: defineInvokeContract(
    'scan:start',
    z.tuple([ScanOptionsSchema]),
    VoidSchema,
    ScanOptionsSchema,
  ),
  cancelScan: defineInvokeContract('scan:cancel', z.tuple([]), VoidSchema),
  listFolderChildren: defineInvokeContract(
    'tree:list-children',
    z.tuple([PathInputSchema]),
    z.array(FolderNodeSchema),
    PathInputSchema,
  ),
  getSettings: defineInvokeContract('settings:get', z.tuple([]), AppSettingsSchema),
  updateSettings: defineInvokeContract(
    'settings:update',
    z.tuple([AppSettingsPatchSchema]),
    AppSettingsSchema,
    AppSettingsPatchSchema,
  ),
  revealInFolder: defineInvokeContract(
    'shell:reveal-in-folder',
    z.tuple([PathInputSchema]),
    VoidSchema,
    PathInputSchema,
  ),
  probeVideoMetadata: defineInvokeContract(
    'media:probe-video',
    z.tuple([VideoProbeRequestSchema]),
    VideoProbeMetadataSchema.nullable(),
    VideoProbeRequestSchema,
  ),
  clearThumbnailCache: defineInvokeContract('cache:clear-thumbnails', z.tuple([]), VoidSchema),
  getMediaIndexStats: defineInvokeContract('index:get-stats', z.tuple([]), MediaIndexStatsSchema),
  clearMediaIndex: defineInvokeContract('index:clear', z.tuple([]), VoidSchema),
  getMediaToolsStatus: defineInvokeContract(
    'media-tools:get-status',
    z.tuple([]),
    MediaToolsStatusSchema,
  ),
  getDiagnosticsSnapshot: defineInvokeContract(
    'debug:get-diagnostics',
    z.tuple([]),
    DiagnosticsSnapshotSchema,
  ),
} as const;

export const InvokeIpcContractList = Object.values(InvokeIpcContracts);
