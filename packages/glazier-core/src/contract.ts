/**
 * The Glazier engine's public contract: every domain value that crosses a process boundary
 * (renderer ↔ main ↔ engine) and every engine method's input and output, as zod schemas. Each
 * boundary parses with these, so the schemas own the types. This module imports nothing from
 * Node, so the renderer can bundle it.
 */
import { z } from "zod";

export const RootIdSchema = z.number().int().positive().brand<"RootId">();

export type RootId = z.infer<typeof RootIdSchema>;

export const FileIdSchema = z.number().int().positive().brand<"FileId">();

export type FileId = z.infer<typeof FileIdSchema>;

export const PlanIdSchema = z.number().int().positive().brand<"PlanId">();

export type PlanId = z.infer<typeof PlanIdSchema>;

export const HoldingIdSchema = z.number().int().positive().brand<"HoldingId">();

export type HoldingId = z.infer<typeof HoldingIdSchema>;

export const JobIdSchema = z.string().min(1).brand<"JobId">();

export type JobId = z.infer<typeof JobIdSchema>;

/** What a file is, from its bytes first and its extension second. */
export const FileKindSchema = z.enum(["image", "video", "audio", "pdf", "other", "junk"]);

export type FileKind = z.infer<typeof FileKindSchema>;

/** The format a file's first bytes identify, which can differ from what its extension claims. */
export const FileFormatSchema = z.enum([
  "png",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "avif",
  "heic",
  "psd",
  "svg",
  "mp4",
  "mov",
  "matroska",
  "webm",
  "mpegts",
  "avi",
  "flv",
  "asf",
  "mp3",
  "m4a",
  "wav",
  "flac",
  "ogg",
  "pdf",
  "zip",
  "rar",
  "7z",
  "empty",
  "unknown",
]);

export type FileFormat = z.infer<typeof FileFormatSchema>;

/**
 * Whether a video can be heard: no audio track at all, a track that is silent, a track with
 * sound, or a track the loudness pass has not measured yet.
 */
export const AudioStateSchema = z.enum(["none", "silent", "sound", "unmeasured"]);

export type AudioState = z.infer<typeof AudioStateSchema>;

export const RootSchema = z.object({
  id: RootIdSchema,
  path: z.string(),
  name: z.string(),
  addedAt: z.number(),
  lastScanAt: z.number().nullable(),
  fileCount: z.number().int(),
  totalBytes: z.number(),
});

export type Root = z.infer<typeof RootSchema>;

export const FileRowSchema = z.object({
  id: FileIdSchema,
  rootId: RootIdSchema,
  /** Path inside the root with forward slashes, as Lockstep and Pane View name it. */
  relPath: z.string(),
  absPath: z.string(),
  name: z.string(),
  dir: z.string(),
  ext: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  kind: FileKindSchema,
  format: FileFormatSchema.nullable(),
  extensionMismatch: z.boolean(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  frames: z.number().int().nullable(),
  durationMs: z.number().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  audioState: AudioStateSchema.nullable(),
  bitrate: z.number().nullable(),
  probeError: z.string().nullable(),
  sha256: z.string().nullable(),
});

export type FileRow = z.infer<typeof FileRowSchema>;

export const FileFlagSchema = z.enum([
  "extension-mismatch",
  "undecodable",
  "zero-byte",
  "junk",
  "animated",
  "duplicate",
  /** Files no Latch Works app shows (not an image, video or PDF extension). */
  "unsupported",
]);

export type FileFlag = z.infer<typeof FileFlagSchema>;

export const FileSortColumnSchema = z.enum(["name", "path", "size", "mtime", "kind", "duration"]);

export const FileQuerySchema = z.object({
  rootId: RootIdSchema.nullable(),
  search: z.string(),
  kinds: z.array(FileKindSchema),
  formats: z.array(FileFormatSchema),
  audioStates: z.array(AudioStateSchema),
  flags: z.array(FileFlagSchema),
  /** Only files under this folder (relative to the root), when set. */
  dir: z.string().nullable(),
  sort: FileSortColumnSchema,
  descending: z.boolean(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(1000),
});

export type FileQuery = z.infer<typeof FileQuerySchema>;

export const FilePageSchema = z.object({
  total: z.number().int(),
  totalBytes: z.number(),
  rows: z.array(FileRowSchema),
});

export type FilePage = z.infer<typeof FilePageSchema>;

export const FindingKindSchema = z.enum([
  "extension-mismatch",
  "undecodable",
  "zero-byte",
  "junk",
  "empty-folder",
  "unsupported",
  "presigned-delivery",
  "unconvertible-video",
]);

export type FindingKind = z.infer<typeof FindingKindSchema>;

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  count: z.number().int(),
  bytes: z.number(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const FormatTotalSchema = z.object({
  format: FileFormatSchema.nullable(),
  kind: FileKindSchema,
  files: z.number().int(),
  bytes: z.number(),
});

export const OverviewSchema = z.object({
  files: z.number().int(),
  bytes: z.number(),
  folders: z.number().int(),
  lastScanAt: z.number().nullable(),
  byFormat: z.array(FormatTotalSchema),
  duplicates: z.object({
    groups: z.number().int(),
    files: z.number().int(),
    reclaimableBytes: z.number(),
  }),
  optimizable: z.object({ files: z.number().int(), bytes: z.number() }),
  sound: z.object({
    videos: z.number().int(),
    none: z.number().int(),
    silent: z.number().int(),
    sound: z.number().int(),
    unmeasured: z.number().int(),
  }),
  findings: z.array(FindingSchema),
});

export type Overview = z.infer<typeof OverviewSchema>;

export const ExactGroupSchema = z.object({
  sha256: z.string(),
  size: z.number(),
  /** Distinct files on disk; hard links to one file count once. */
  physicalCopies: z.number().int(),
  reclaimableBytes: z.number(),
  members: z.array(FileRowSchema),
  /** Members linked to the same file on disk as another member. */
  hardLinkedIds: z.array(FileIdSchema),
});

export type ExactGroup = z.infer<typeof ExactGroupSchema>;

export const ExactGroupPageSchema = z.object({
  total: z.number().int(),
  reclaimableBytes: z.number(),
  groups: z.array(ExactGroupSchema),
});

export const SimilarityLevelSchema = z.enum(["strict", "balanced", "loose"]);

export type SimilarityLevel = z.infer<typeof SimilarityLevelSchema>;

export const SimilarGroupSchema = z.object({
  id: z.number().int(),
  kind: z.enum(["image", "video"]),
  /** The largest fingerprint distance between linked members, out of 64 bits. */
  distance: z.number(),
  members: z.array(FileRowSchema),
});

export type SimilarGroup = z.infer<typeof SimilarGroupSchema>;

export const SimilarGroupPageSchema = z.object({
  total: z.number().int(),
  fingerprinted: z.number().int(),
  fingerprintable: z.number().int(),
  groups: z.array(SimilarGroupSchema),
});

export const OptimizeCategorySchema = z.enum([
  "still-to-avif",
  "animation-to-mp4",
  "video-remux",
  "video-convert",
  "rename-avif",
  "rename-mp4",
]);

export type OptimizeCategory = z.infer<typeof OptimizeCategorySchema>;

export const OptimizeSummarySchema = z.object({
  categories: z.array(
    z.object({
      category: OptimizeCategorySchema,
      files: z.number().int(),
      bytes: z.number(),
    }),
  ),
  skipped: z.array(
    z.object({
      reason: z.string(),
      files: z.number().int(),
    }),
  ),
});

export type OptimizeSummary = z.infer<typeof OptimizeSummarySchema>;

export const OptimizeEstimateSchema = z.object({
  category: OptimizeCategorySchema,
  sampled: z.number().int(),
  /** Output size as a share of input size, across the sample: low and high quartile. */
  ratioLow: z.number(),
  ratioHigh: z.number(),
});

export type OptimizeEstimate = z.infer<typeof OptimizeEstimateSchema>;

export const VideoCodecChoiceSchema = z.enum(["avc", "hevc", "av1"]);

export type VideoCodecChoice = z.infer<typeof VideoCodecChoiceSchema>;

export const VideoQualitySchema = z.enum(["medium", "high", "very-high"]);

export type VideoQuality = z.infer<typeof VideoQualitySchema>;

export const PlanRequestSchema = z.discriminatedUnion("kind", [
  /** Move files to their root's holding folder. */
  z.object({ kind: z.literal("hold"), fileIds: z.array(FileIdSchema).min(1) }),
  z.object({
    kind: z.literal("move"),
    fileIds: z.array(FileIdSchema).min(1),
    /** An absolute folder; files keep their names. */
    targetDir: z.string().min(1),
  }),
  z.object({
    kind: z.literal("rename"),
    renames: z.array(z.object({ fileId: FileIdSchema, name: z.string().min(1) })).min(1),
  }),
  z.object({ kind: z.literal("fix-extension"), fileIds: z.array(FileIdSchema).min(1) }),
  z.object({
    kind: z.literal("optimize"),
    rootId: RootIdSchema,
    categories: z.array(OptimizeCategorySchema).min(1),
    /** Limit to these files; every candidate in the categories when null. */
    fileIds: z.array(FileIdSchema).nullable(),
  }),
  z.object({
    kind: z.literal("reencode"),
    fileIds: z.array(FileIdSchema).min(1),
    codec: VideoCodecChoiceSchema,
    quality: VideoQualitySchema,
  }),
  z.object({ kind: z.literal("strip-audio"), fileIds: z.array(FileIdSchema).min(1) }),
  z.object({
    kind: z.literal("resolve-duplicates"),
    groups: z.array(z.object({ keep: FileIdSchema, remove: z.array(FileIdSchema).min(1) })).min(1),
  }),
  z.object({ kind: z.literal("clean-junk"), rootId: RootIdSchema }),
  z.object({ kind: z.literal("remove-empty-folders"), rootId: RootIdSchema }),
]);

export type PlanRequest = z.infer<typeof PlanRequestSchema>;

/** Every plan request's kind; `satisfies` keeps the list to kinds the request union has. */
export const PlanKindSchema = z.enum([
  "hold",
  "move",
  "rename",
  "fix-extension",
  "optimize",
  "reencode",
  "strip-audio",
  "resolve-duplicates",
  "clean-junk",
  "remove-empty-folders",
] as const satisfies readonly PlanRequest["kind"][]);

export type PlanKind = z.infer<typeof PlanKindSchema>;

export const PlanStepActionSchema = z.enum([
  "hold",
  "move",
  "rename",
  "convert-avif",
  "convert-animation",
  "convert-video",
  "remove-folder",
]);

export type PlanStepAction = z.infer<typeof PlanStepActionSchema>;

export const PlanPreviewSchema = z.object({
  planId: PlanIdSchema,
  kind: PlanKindSchema,
  steps: z.number().int(),
  byAction: z.array(z.object({ action: PlanStepActionSchema, steps: z.number().int() })),
  /** Bytes the plan moves into holding outright (removals); conversions add their originals. */
  bytesToHolding: z.number(),
  bytesTouched: z.number(),
  lockstep: z.object({
    removedPaths: z.number().int(),
    addedPaths: z.number().int(),
  }),
  warnings: z.array(z.string()),
});

export type PlanPreview = z.infer<typeof PlanPreviewSchema>;

export const PlanStatusSchema = z.enum([
  "draft",
  "applying",
  "applied",
  "partial",
  "failed",
  "cancelled",
  "undone",
]);

export const PlanSummarySchema = z.object({
  id: PlanIdSchema,
  kind: PlanKindSchema,
  createdAt: z.number(),
  status: PlanStatusSchema,
  steps: z.number().int(),
  done: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  undone: z.number().int(),
  bytesBefore: z.number(),
  bytesAfter: z.number(),
});

export type PlanSummary = z.infer<typeof PlanSummarySchema>;

export const StepStatusSchema = z.enum(["pending", "done", "skipped", "failed", "undone"]);

export const PlanStepSchema = z.object({
  id: z.number().int(),
  action: PlanStepActionSchema,
  fromPath: z.string(),
  toPath: z.string().nullable(),
  status: StepStatusSchema,
  message: z.string().nullable(),
  bytesBefore: z.number(),
  bytesAfter: z.number().nullable(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanStepPageSchema = z.object({
  total: z.number().int(),
  steps: z.array(PlanStepSchema),
});

export type PlanStepPage = z.infer<typeof PlanStepPageSchema>;

export const HoldingItemSchema = z.object({
  id: HoldingIdSchema,
  rootId: RootIdSchema,
  originalPath: z.string(),
  holdPath: z.string(),
  size: z.number(),
  heldAt: z.number(),
  planId: PlanIdSchema.nullable(),
  reason: z.string(),
});

export type HoldingItem = z.infer<typeof HoldingItemSchema>;

export const HoldingListSchema = z.object({
  totalBytes: z.number(),
  total: z.number().int(),
  items: z.array(HoldingItemSchema),
});

export type HoldingList = z.infer<typeof HoldingListSchema>;

export const JobTypeSchema = z.enum(["scan", "similar", "sound", "estimate", "apply", "undo"]);

export const JobSchema = z.object({
  id: JobIdSchema,
  type: JobTypeSchema,
  rootId: RootIdSchema.nullable(),
  label: z.string(),
  state: z.enum(["queued", "running", "paused", "done", "failed", "cancelled"]),
  done: z.number(),
  total: z.number(),
  startedAt: z.number(),
  message: z.string().nullable(),
});

export type Job = z.infer<typeof JobSchema>;

export const SettingsSchema = z.object({
  /** Folders whose files duplicate resolution never removes, relative to their root. */
  protectedFolders: z.array(z.object({ rootId: RootIdSchema, dir: z.string() })),
  similarity: SimilarityLevelSchema,
  reencodeCodec: VideoCodecChoiceSchema,
  reencodeQuality: VideoQualitySchema,
});

export type Settings = z.infer<typeof SettingsSchema>;

export const EncoderCapabilitiesSchema = z.object({
  /** Hardware or software encoders Chromium's WebCodecs offers on this machine. */
  video: z.object({ avc: z.boolean(), hevc: z.boolean(), av1: z.boolean() }),
  aac: z.boolean(),
  ffmpeg: z.boolean(),
  ffprobe: z.boolean(),
});

export type EncoderCapabilities = z.infer<typeof EncoderCapabilitiesSchema>;

export const EngineStateSchema = z.object({
  roots: z.array(RootSchema),
  settings: SettingsSchema,
  jobs: z.array(JobSchema),
  capabilities: EncoderCapabilitiesSchema,
});

export type EngineState = z.infer<typeof EngineStateSchema>;

export const EngineEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("job"), job: JobSchema }),
  z.object({ kind: z.literal("catalog-changed"), rootId: RootIdSchema.nullable() }),
  z.object({ kind: z.literal("roots-changed"), roots: z.array(RootSchema) }),
  z.object({ kind: z.literal("capabilities"), capabilities: EncoderCapabilitiesSchema }),
]);

export type EngineEvent = z.infer<typeof EngineEventSchema>;

export const VideoTrackPlanSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("copy") }),
  z.object({ action: z.literal("encode"), codec: z.enum(["avc", "hevc", "av1"]) }),
]);

export const AudioTrackPlanSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("copy") }),
  z.object({ action: z.literal("encode-aac") }),
  z.object({ action: z.literal("drop") }),
]);

export const AnimatedImageMimeTypeSchema = z.enum(["image/gif", "image/webp", "image/png"]);

/** A conversion the transcoder window runs with Mediabunny and WebCodecs. */
export const TranscodeJobSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("animation"),
    srcPath: z.string(),
    outPath: z.string(),
    mimeType: AnimatedImageMimeTypeSchema,
  }),
  z.object({
    kind: z.literal("video"),
    srcPath: z.string(),
    outPath: z.string(),
    video: VideoTrackPlanSchema,
    audio: AudioTrackPlanSchema,
    quality: VideoQualitySchema,
  }),
]);

export type TranscodeJob = z.infer<typeof TranscodeJobSchema>;

export const StillEncodeRequestSchema = z.object({ srcPath: z.string(), outPath: z.string() });

export type StillEncodeRequest = z.infer<typeof StillEncodeRequestSchema>;

export const StillEncodeResultSchema = z.object({
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  encoder: z.enum(["wasm", "sharp"]),
});

export type StillEncodeResult = z.infer<typeof StillEncodeResultSchema>;

const RootRefSchema = z.object({ rootId: RootIdSchema });

const OptionalRootRefSchema = z.object({ rootId: RootIdSchema.nullable() });

const PagingSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(500),
});

const NothingSchema = z.object({});

function method<TInput extends z.ZodType, TOutput extends z.ZodType>(
  input: TInput,
  output: TOutput,
) {
  return { input, output };
}

/** Every engine method, by name. The main process forwards these; the renderer calls them. */
export const EngineMethods = {
  getState: method(NothingSchema, EngineStateSchema),
  addRoot: method(z.object({ path: z.string().min(1) }), RootSchema),
  removeRoot: method(RootRefSchema, z.array(RootSchema)),
  scanRoot: method(RootRefSchema, JobSchema),
  cancelJob: method(z.object({ jobId: JobIdSchema }), NothingSchema),
  pauseJob: method(z.object({ jobId: JobIdSchema, paused: z.boolean() }), NothingSchema),
  overview: method(OptionalRootRefSchema, OverviewSchema),
  listFiles: method(FileQuerySchema, FilePageSchema),
  getFiles: method(z.object({ ids: z.array(FileIdSchema).max(500) }), z.array(FileRowSchema)),
  listFolders: method(RootRefSchema, z.array(z.string())),
  exactDuplicates: method(OptionalRootRefSchema.extend(PagingSchema.shape), ExactGroupPageSchema),
  analyzeSimilar: method(OptionalRootRefSchema, JobSchema),
  similarDuplicates: method(
    OptionalRootRefSchema.extend(PagingSchema.shape).extend({ level: SimilarityLevelSchema }),
    SimilarGroupPageSchema,
  ),
  analyzeSound: method(OptionalRootRefSchema, JobSchema),
  optimizeSummary: method(RootRefSchema, OptimizeSummarySchema),
  estimateOptimize: method(
    RootRefSchema.extend({ category: OptimizeCategorySchema }),
    OptimizeEstimateSchema,
  ),
  previewPlan: method(PlanRequestSchema, PlanPreviewSchema),
  applyPlan: method(z.object({ planId: PlanIdSchema }), JobSchema),
  discardPlan: method(z.object({ planId: PlanIdSchema }), NothingSchema),
  listPlans: method(OptionalRootRefSchema.extend(PagingSchema.shape), z.array(PlanSummarySchema)),
  planSteps: method(
    z.object({ planId: PlanIdSchema }).extend(PagingSchema.shape),
    PlanStepPageSchema,
  ),
  undoPlan: method(z.object({ planId: PlanIdSchema }), JobSchema),
  listHolding: method(RootRefSchema.extend(PagingSchema.shape), HoldingListSchema),
  restoreHolding: method(
    z.object({ ids: z.array(HoldingIdSchema).min(1) }),
    z.object({ restored: z.number().int(), failed: z.array(z.string()) }),
  ),
  holdingBatches: method(RootRefSchema, z.array(z.string())),
  markHoldingEmptied: method(
    RootRefSchema.extend({ batchPaths: z.array(z.string()) }),
    z.object({ emptied: z.number().int() }),
  ),
  updateSettings: method(SettingsSchema, SettingsSchema),
  thumbnail: method(
    z.object({ path: z.string().min(1), size: z.number().int().min(32).max(1024) }),
    z.object({ path: z.string().nullable() }),
  ),
  authorizedRoots: method(NothingSchema, z.array(z.string())),
} as const;

export type EngineMethodName = keyof typeof EngineMethods;

export type EngineInput<M extends EngineMethodName> = z.infer<(typeof EngineMethods)[M]["input"]>;

export type EngineOutput<M extends EngineMethodName> = z.infer<(typeof EngineMethods)[M]["output"]>;

export const EngineMethodNameSchema = z.enum(
  // SAFETY: `Object.keys` returns exactly the keys of the `EngineMethods` literal above.
  Object.keys(EngineMethods) as [EngineMethodName, ...EngineMethodName[]],
);
