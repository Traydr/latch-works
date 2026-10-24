import { z } from "zod";

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
} from "./contracts";

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
    "frame:dialog:open-folder",
    z.tuple([]),
    PathInputSchema.nullable(),
  ),
  resolveInputPath: defineInvokeContract(
    "frame:path:resolve-input",
    z.tuple([PathInputSchema]),
    PathInputSchema.nullable(),
    PathInputSchema,
  ),
  authorizeDroppedPath: defineInvokeContract(
    "frame:path:authorize-dropped",
    z.tuple([PathInputSchema]),
    PathInputSchema.nullable(),
    PathInputSchema,
  ),
  startScan: defineInvokeContract(
    "frame:scan:start",
    z.tuple([ScanOptionsSchema]),
    VoidSchema,
    ScanOptionsSchema,
  ),
  cancelScan: defineInvokeContract("frame:scan:cancel", z.tuple([]), VoidSchema),
  listFolderChildren: defineInvokeContract(
    "frame:tree:list-children",
    z.tuple([PathInputSchema]),
    z.array(FolderNodeSchema),
    PathInputSchema,
  ),
  getSettings: defineInvokeContract("frame:settings:get", z.tuple([]), AppSettingsSchema),
  updateSettings: defineInvokeContract(
    "frame:settings:update",
    z.tuple([AppSettingsPatchSchema]),
    AppSettingsSchema,
    AppSettingsPatchSchema,
  ),
  revealInFolder: defineInvokeContract(
    "frame:shell:reveal-in-folder",
    z.tuple([PathInputSchema]),
    VoidSchema,
    PathInputSchema,
  ),
  probeVideoMetadata: defineInvokeContract(
    "frame:media:probe-video",
    z.tuple([VideoProbeRequestSchema]),
    VideoProbeMetadataSchema.nullable(),
    VideoProbeRequestSchema,
  ),
  clearThumbnailCache: defineInvokeContract(
    "frame:cache:clear-thumbnails",
    z.tuple([]),
    VoidSchema,
  ),
  getMediaIndexStats: defineInvokeContract(
    "frame:index:get-stats",
    z.tuple([]),
    MediaIndexStatsSchema,
  ),
  clearMediaIndex: defineInvokeContract("frame:index:clear", z.tuple([]), VoidSchema),
  getMediaToolsStatus: defineInvokeContract(
    "frame:media-tools:get-status",
    z.tuple([]),
    MediaToolsStatusSchema,
  ),
  getDiagnosticsSnapshot: defineInvokeContract(
    "frame:debug:get-diagnostics",
    z.tuple([]),
    DiagnosticsSnapshotSchema,
  ),
} as const;

export const InvokeIpcContractList = Object.values(InvokeIpcContracts);

/** View's main → window channels, beside its invoke contracts. */
export const ViewChannels = {
  command: "frame:command",
  scanEvent: "frame:scan-event",
} as const;
