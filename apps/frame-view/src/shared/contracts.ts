import { z } from 'zod';

const MAX_PATH_LENGTH = 4096;
const MAX_EXTENSION_COUNT = 64;
const MAX_EXTENSION_LENGTH = 16;

export const PathInputSchema = z.string().trim().min(1).max(MAX_PATH_LENGTH);

const normalizedExtensionSchema = z
  .string()
  .transform((value) => value.replace(/^\./, '').trim().toLowerCase())
  .pipe(
    z
      .string()
      .regex(/^[a-z0-9]+$/)
      .max(MAX_EXTENSION_LENGTH),
  );

const normalizedExtensionsSchema = z
  .array(normalizedExtensionSchema)
  .max(MAX_EXTENSION_COUNT)
  .transform((values) => Array.from(new Set(values)));

const integerNumberSchema = z.number().int();
const finiteNumberSchema = z.number();

export const ThemeModeSchema = z.enum(['system', 'light', 'dark']);
export const GallerySortModeSchema = z.enum([
  'name-asc',
  'name-desc',
  'date-newest',
  'date-oldest',
  'random',
]);
export const MediaTypeSchema = z.enum(['image', 'video']);

export const FileFilterSettingsSchema = z.object({
  imageExtensions: normalizedExtensionsSchema,
  videoExtensions: normalizedExtensionsSchema,
  showImages: z.boolean(),
  showVideos: z.boolean(),
});

export const RootGalleryPreferencesSchema = z.object({
  comicMode: z.boolean(),
  excludedRootChildPaths: z.array(PathInputSchema).max(256),
});

export const RootGalleryPreferencesMapSchema = z.record(
  PathInputSchema,
  RootGalleryPreferencesSchema,
);

export const DebugSettingsSchema = z.object({
  enableDebugLogging: z.boolean(),
  enablePerformanceMonitoring: z.boolean(),
});

export const AppSettingsSchema = z.object({
  theme: ThemeModeSchema,
  rememberLastFolder: z.boolean(),
  recursiveDefault: z.boolean(),
  autoplayOnHover: z.boolean(),
  autoplayVideos: z.boolean(),
  loopViewerNavigation: z.boolean(),
  previewAudioEnabled: z.boolean(),
  loopVideos: z.boolean(),
  thumbnailSize: finiteNumberSchema.transform((value) =>
    Math.max(64, Math.min(1024, Math.round(value))),
  ),
  sortMode: GallerySortModeSchema,
  randomSeed: integerNumberSchema,
  filters: FileFilterSettingsSchema,
  rootGalleryPreferences: RootGalleryPreferencesMapSchema,
  lastFolderPath: PathInputSchema.nullable(),
  debug: DebugSettingsSchema,
});

export const AppSettingsPatchSchema = z.strictObject({
  theme: ThemeModeSchema.optional(),
  rememberLastFolder: z.boolean().optional(),
  recursiveDefault: z.boolean().optional(),
  autoplayOnHover: z.boolean().optional(),
  autoplayVideos: z.boolean().optional(),
  loopViewerNavigation: z.boolean().optional(),
  previewAudioEnabled: z.boolean().optional(),
  loopVideos: z.boolean().optional(),
  thumbnailSize: finiteNumberSchema.optional(),
  sortMode: GallerySortModeSchema.optional(),
  randomSeed: integerNumberSchema.optional(),
  rootGalleryPreferences: RootGalleryPreferencesMapSchema.optional(),
  filters: z
    .object({
      imageExtensions: normalizedExtensionsSchema.optional(),
      videoExtensions: normalizedExtensionsSchema.optional(),
      showImages: z.boolean().optional(),
      showVideos: z.boolean().optional(),
    })
    .optional(),
  lastFolderPath: PathInputSchema.nullable().optional(),
  debug: z
    .object({
      enableDebugLogging: z.boolean().optional(),
      enablePerformanceMonitoring: z.boolean().optional(),
    })
    .optional(),
});

export const MediaItemSchema = z.object({
  id: z.string(),
  path: PathInputSchema,
  name: z.string(),
  extension: normalizedExtensionSchema,
  mediaType: MediaTypeSchema,
  size: finiteNumberSchema.nonnegative(),
  mtimeMs: finiteNumberSchema.nonnegative(),
  width: finiteNumberSchema.nonnegative().optional(),
  height: finiteNumberSchema.nonnegative().optional(),
  durationMs: finiteNumberSchema.nonnegative().optional(),
  codec: z.string().optional(),
  thumbnailPath: z.string().optional(),
});

export const VideoProbeRequestSchema = z.object({
  path: PathInputSchema,
  mtimeMs: finiteNumberSchema.positive(),
  size: finiteNumberSchema.nonnegative(),
});

export const VideoProbeMetadataSchema = z.object({
  durationMs: finiteNumberSchema.nonnegative().optional(),
  width: finiteNumberSchema.nonnegative().optional(),
  height: finiteNumberSchema.nonnegative().optional(),
  codec: z.string().optional(),
});

export const ScanOptionsSchema = z.object({
  rootPath: PathInputSchema,
  recursive: z.boolean(),
  filters: FileFilterSettingsSchema,
  excludedRootChildPaths: z.array(PathInputSchema).max(256).default([]),
});

export const FolderNodeSchema = z.object({
  path: PathInputSchema,
  name: z.string(),
  hasChildren: z.boolean(),
});

export const MediaIndexStatsSchema = z.object({
  totalItems: integerNumberSchema.nonnegative(),
  uniqueRoots: integerNumberSchema.nonnegative(),
  dbPath: z.string(),
});

export const MediaToolsStatusSchema = z.object({
  ffmpegAvailable: z.boolean(),
  ffprobeAvailable: z.boolean(),
  ffmpegPath: z.string().nullable(),
  ffprobePath: z.string().nullable(),
});

export const ThumbnailJobKindSchema = z.enum(['image', 'video']);
export const ThumbnailJobPrioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const ThumbnailDebugOptionsSchema = z.object({
  enableDebugLogging: z.boolean(),
  enablePerformanceMonitoring: z.boolean(),
});

export const ThumbnailWorkerCapabilitiesSchema = z.object({
  ffmpegAvailable: z.boolean(),
  ffmpegExists: z.boolean(),
  ffmpegPath: z.string().nullable(),
  ffprobeAvailable: z.boolean(),
  ffprobeExists: z.boolean(),
  ffprobePath: z.string().nullable(),
  sharpAvailable: z.boolean(),
  workerPath: z.string().nullable(),
  probeErrors: z.array(z.string()),
});

export const ThumbnailTimingAggregateSchema = z.object({
  averageMs: finiteNumberSchema.nonnegative(),
  count: integerNumberSchema.nonnegative(),
  maxMs: finiteNumberSchema.nonnegative(),
});

export const ThumbnailPerformanceSnapshotSchema = z.object({
  diskHit: ThumbnailTimingAggregateSchema.nullable(),
  endToEnd: ThumbnailTimingAggregateSchema.nullable(),
  memoryHit: ThumbnailTimingAggregateSchema.nullable(),
  workerGeneration: ThumbnailTimingAggregateSchema.nullable(),
});

export const ThumbnailDiagnosticsSnapshotSchema = z.object({
  abortedCount: integerNumberSchema.nonnegative(),
  diskCacheHits: integerNumberSchema.nonnegative(),
  generatedCount: integerNumberSchema.nonnegative(),
  imageQueueDepth: integerNumberSchema.nonnegative(),
  imageWorkerCount: integerNumberSchema.nonnegative(),
  inflightRequests: integerNumberSchema.nonnegative(),
  memoryCacheHits: integerNumberSchema.nonnegative(),
  recentFailures: z.array(z.string()),
  recentWorkerEvents: z.array(z.string()),
  sharpDecodeFailureCount: integerNumberSchema.nonnegative(),
  timings: ThumbnailPerformanceSnapshotSchema.nullable(),
  videoExtractionFailureCount: integerNumberSchema.nonnegative(),
  videoQueueDepth: integerNumberSchema.nonnegative(),
  videoWorkerCount: integerNumberSchema.nonnegative(),
  workerCrashCount: integerNumberSchema.nonnegative(),
  workerRestartCount: integerNumberSchema.nonnegative(),
});

export const DiagnosticsSnapshotSchema = z.object({
  appVersion: z.string(),
  currentFolder: z
    .object({
      folderName: z.string().nullable(),
      itemCount: integerNumberSchema.nonnegative(),
      recursive: z.boolean(),
      scanState: z.enum(['idle', 'loading', 'done', 'error']),
    })
    .nullable(),
  debug: DebugSettingsSchema,
  electronVersion: z.string(),
  isPackaged: z.boolean(),
  mediaTools: MediaToolsStatusSchema,
  platform: z.string(),
  thumbnails: ThumbnailDiagnosticsSnapshotSchema,
  thumbnailWorker: ThumbnailWorkerCapabilitiesSchema.nullable(),
  thumbnailWorkerPerformance: ThumbnailPerformanceSnapshotSchema.nullable(),
  arch: z.string(),
});

export const AppCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open-folder-dialog') }),
  z.object({ type: z.literal('refresh-current-folder') }),
  z.object({ type: z.literal('toggle-settings') }),
  z.object({ type: z.literal('scan-path'), path: PathInputSchema }),
]);

export const ScanEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('reset'),
    runId: integerNumberSchema,
    rootPath: PathInputSchema,
    recursive: z.boolean(),
  }),
  z.object({
    type: z.literal('progress'),
    runId: integerNumberSchema,
    scannedDirectories: integerNumberSchema.nonnegative(),
    discoveredItems: integerNumberSchema.nonnegative(),
    currentPath: PathInputSchema,
  }),
  z.object({
    type: z.literal('batch'),
    runId: integerNumberSchema,
    items: z.array(MediaItemSchema),
  }),
  z.object({
    type: z.literal('done'),
    runId: integerNumberSchema,
    totalItems: integerNumberSchema.nonnegative(),
    elapsedMs: finiteNumberSchema.nonnegative(),
  }),
  z.object({ type: z.literal('cancelled'), runId: integerNumberSchema }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    path: z.string().optional(),
    runId: integerNumberSchema.optional(),
  }),
]);

export const IpcErrorPayloadSchema = z.discriminatedUnion('_tag', [
  z.object({
    _tag: z.literal('ValidationError'),
    message: z.string(),
    operation: z.string(),
    issues: z.array(z.string()).optional(),
    cause: z.unknown().optional(),
  }),
  z.object({
    _tag: z.literal('FileSystemError'),
    message: z.string(),
    operation: z.string(),
    path: z.string().optional(),
    cause: z.unknown().optional(),
  }),
  z.object({
    _tag: z.literal('DatabaseError'),
    message: z.string(),
    operation: z.string(),
    cause: z.unknown().optional(),
  }),
  z.object({
    _tag: z.literal('MediaToolsError'),
    message: z.string(),
    operation: z.string(),
    cause: z.unknown().optional(),
  }),
  z.object({
    _tag: z.literal('WorkerError'),
    message: z.string(),
    worker: z.enum(['catalog', 'thumbnail']),
    operation: z.string(),
    cause: z.unknown().optional(),
  }),
  z.object({
    _tag: z.literal('ProtocolError'),
    message: z.string(),
    channel: z.string(),
    payload: z.unknown().optional(),
  }),
]);

export const ThumbnailJobRequestSchema = z.object({
  cacheKey: z.string(),
  kind: ThumbnailJobKindSchema,
  mediaPath: PathInputSchema,
  priority: ThumbnailJobPrioritySchema,
  thumbSize: finiteNumberSchema.nonnegative(),
});

export const ThumbnailWorkerJobResultSchema = z.object({
  bytes: z.instanceof(Uint8Array),
  cacheCreated: z.boolean(),
  cacheKey: z.string(),
  contentType: z.literal('image/webp'),
});

export const ThumbnailWorkerRequestSchema = z.discriminatedUnion('type', [
  z.object({
    requestId: integerNumberSchema,
    type: z.literal('generate-thumbnail'),
    job: ThumbnailJobRequestSchema,
  }),
  z.object({ requestId: integerNumberSchema, type: z.literal('cancel-thumbnail') }),
  z.object({ requestId: integerNumberSchema, type: z.literal('get-capabilities') }),
  z.object({
    requestId: integerNumberSchema,
    type: z.literal('set-debug-options'),
    options: ThumbnailDebugOptionsSchema,
  }),
]);

export const ThumbnailWorkerResponseSchema = z.union([
  z.object({
    requestId: integerNumberSchema,
    ok: z.literal(true),
    result: z.union([ThumbnailWorkerJobResultSchema, ThumbnailWorkerCapabilitiesSchema]),
  }),
  z.object({
    requestId: integerNumberSchema,
    ok: z.literal(false),
    error: z.string(),
    errorCode: z
      .enum(['abort', 'sharp-decode', 'video-extraction', 'worker-init', 'unknown'])
      .optional(),
  }),
]);

export const ThumbnailWorkerEventSchema = z.object({
  type: z.literal('worker-ready'),
  capabilities: ThumbnailWorkerCapabilitiesSchema,
});

export const CatalogWorkerRequestSchema = z.discriminatedUnion('type', [
  z.object({
    requestId: integerNumberSchema,
    type: z.literal('start-scan'),
    options: ScanOptionsSchema,
  }),
  z.object({ requestId: integerNumberSchema, type: z.literal('cancel-scan') }),
  z.object({ requestId: integerNumberSchema, type: z.literal('get-index-stats') }),
  z.object({ requestId: integerNumberSchema, type: z.literal('clear-index') }),
]);

export const CatalogWorkerResponseSchema = z.union([
  z.object({
    requestId: integerNumberSchema,
    ok: z.literal(true),
    result: MediaIndexStatsSchema.optional(),
  }),
  z.object({
    requestId: integerNumberSchema,
    ok: z.literal(false),
    error: z.string(),
  }),
]);

export const CatalogWorkerEventSchema = z.object({
  type: z.literal('scan-event'),
  event: ScanEventSchema,
});

export function createTypeGuard<T>(schema: z.ZodType<T>): (value: unknown) => value is T {
  return (value): value is T => schema.safeParse(value).success;
}

export function createSerializedResultSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.union([
    z.object({
      status: z.literal('ok'),
      value: valueSchema,
    }),
    z.object({
      status: z.literal('error'),
      error: IpcErrorPayloadSchema,
    }),
  ]);
}
