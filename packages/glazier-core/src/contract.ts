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
  /** Files the archive policy would convert or rename, as the Convert step counts them. */
  "convertible",
]);

export type FileFlag = z.infer<typeof FileFlagSchema>;

export const FileSortColumnSchema = z.enum(["name", "path", "size", "mtime", "kind", "duration"]);

export const FileQuerySchema = z.object({
  rootId: RootIdSchema.nullable(),
  search: z.string(),
  kinds: z.array(FileKindSchema),
  formats: z.array(FileFormatSchema),
  audioStates: z.array(AudioStateSchema),
  /** A file matches when it has any of these flags; the other lists combine the same way. */
  flags: z.array(FileFlagSchema),
  /** Only files under this folder (relative to the root), when set. */
  dir: z.string().nullable(),
  sort: FileSortColumnSchema,
  descending: z.boolean(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(1000),
});

export type FileQuery = z.infer<typeof FileQuerySchema>;

/** A file query without paging or order: which files, not which page of them. */
export const FileFilterSchema = FileQuerySchema.omit({
  offset: true,
  limit: true,
  sort: true,
  descending: true,
});

export type FileFilter = z.infer<typeof FileFilterSchema>;

/** How many files a bulk action can take at once, such as Select All. */
export const MAX_BULK_FILES = 50_000;

export const FilePageSchema = z.object({
  total: z.number().int(),
  totalBytes: z.number(),
  rows: z.array(FileRowSchema),
});

export type FilePage = z.infer<typeof FilePageSchema>;

/** Things a scan finds that need a look but that Glazier has no single fix for. */
export const FindingKindSchema = z.enum([
  "undecodable",
  "zero-byte",
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

const FacetCountSchema = z.object({ files: z.number().int(), bytes: z.number() });

/**
 * File counts per filter value. Each facet is counted under every filter except its own, so a
 * menu can show what choosing a value would match.
 */
export const FileFacetsSchema = z.object({
  kinds: z.array(FacetCountSchema.extend({ value: FileKindSchema })),
  formats: z.array(FacetCountSchema.extend({ value: FileFormatSchema.nullable() })),
  audioStates: z.array(FacetCountSchema.extend({ value: AudioStateSchema })),
  flags: z.array(FacetCountSchema.extend({ value: FileFlagSchema })),
});

export type FileFacets = z.infer<typeof FileFacetsSchema>;

/** What a selection holds, so the selection bar offers only the actions that apply to it. */
export const SelectionSummarySchema = z.object({
  files: z.number().int(),
  bytes: z.number(),
  /** Files the Convert step would convert or rename. */
  convertible: FacetCountSchema,
  videos: z.number().int(),
  /** Videos with an audio track, which Strip audio applies to. */
  withAudio: z.number().int(),
  extensionMismatches: z.number().int(),
});

export type SelectionSummary = z.infer<typeof SelectionSummarySchema>;

/**
 * Which copy of a duplicate set the suggestion keeps, by the first keeper rule that decided, or
 * `different-pictures` when Spot variants keeps every version as a picture of its own.
 */
export const KeepReasonSchema = z.enum([
  "preferred-folder",
  "has-sound",
  "more-pixels",
  "longer",
  "home-folder",
  "archive-format",
  "right-extension",
  "larger-file",
  "original-name",
  "oldest",
  "shorter-path",
  "name-order",
  "different-pictures",
]);

export type KeepReason = z.infer<typeof KeepReasonSchema>;

/**
 * Which open sets to list. `variants` are similar sets Spot variants found to hold only variants
 * (see `DuplicateSet.pictures`); they are not duplicates, so `all` and `similar` leave them out.
 */
export const DuplicateScopeSchema = z.enum(["all", "exact", "similar", "variants"]);

export type DuplicateScope = z.infer<typeof DuplicateScopeSchema>;

/**
 * One picture or video and every version of it in the catalog. Byte-identical copies are one
 * version, so a file belongs to one set only, whether its twins are exact or similar.
 */
export const DuplicateSetSchema = z.object({
  /** Stable while the set's files stay the same: `exact:<sha256>` or `similar:<lowest file id>`. */
  key: z.string(),
  /** `exact` when every file holds the same bytes; `similar` when the versions differ. */
  kind: z.enum(["exact", "similar"]),
  /** Distinct contents, best first; each lists its byte-identical copies, best first. */
  versions: z.array(z.object({ files: z.array(FileRowSchema).min(1) })).min(1),
  /**
   * With Spot variants on, the picture each version shows, by position: versions that are copies
   * of one picture share a number, and versions are ordered picture by picture, best first. Null
   * when Spot variants is off, for videos and animations, and until every version has a print.
   */
  pictures: z.array(z.number().int()).nullable(),
  /**
   * What resolving keeps unless told otherwise: the best version's best copy, or with pictures,
   * each picture's best copy.
   */
  keep: z.array(FileIdSchema).min(1),
  /** Why the kept copy beat the runner-up (see `decidingVersions`). */
  keepReason: KeepReasonSchema,
  /** Bytes the suggested resolution frees; files hard-linked to a kept file free nothing. */
  reclaimableBytes: z.number(),
  /** Members that share their bytes on disk with another member (hard links). */
  hardLinkedIds: z.array(FileIdSchema),
  /** For similar sets, the largest fingerprint distance (of 64 bits) that joined them. */
  distance: z.number().nullable(),
  /** Set when the owner said these files are not duplicates; such sets are hidden by default. */
  dismissalId: z.number().int().nullable(),
});

export type DuplicateSet = z.infer<typeof DuplicateSetSchema>;

/** Keep reasons that only break a tie between versions that are otherwise alike. */
const TIE_BREAKERS: ReadonlySet<KeepReason> = new Set([
  "larger-file",
  "oldest",
  "shorter-path",
  "name-order",
]);

type SetDecision = Pick<DuplicateSet, "kind" | "keepReason" | "versions" | "pictures">;

/**
 * The versions the keep reason compares, by position: the kept one and the runner-up it beat.
 * With pictures that is the first picture holding two versions; null when none does.
 */
export function decidingVersions(set: SetDecision): { kept: number; runnerUp: number } | null {
  if (set.pictures === null) {
    return set.versions.length > 1 ? { kept: 0, runnerUp: 1 } : null;
  }

  for (let index = 1; index < set.pictures.length; index += 1) {
    if (set.pictures[index] === set.pictures[index - 1]) {
      return { kept: index - 1, runnerUp: index };
    }
  }

  return null;
}

/**
 * Whether a similar set's suggestion is a close call: its versions match on pixels, length,
 * sound and format, and a tie-breaker chose (a file under a tenth larger, the oldest, the
 * shortest path, the first name). The owner should look at those.
 */
export function isCloseCall(set: SetDecision): boolean {
  if (set.kind !== "similar" || !TIE_BREAKERS.has(set.keepReason)) {
    return false;
  }

  if (set.keepReason !== "larger-file") {
    return true;
  }

  const pair = decidingVersions(set);
  const bestSize = pair ? (set.versions[pair.kept]?.files[0]?.size ?? 0) : 0;
  const nextSize = pair ? (set.versions[pair.runnerUp]?.files[0]?.size ?? 0) : 0;

  return nextSize > 0 && bestSize / nextSize < 1.1;
}

const DuplicateTotalsSchema = z.object({
  sets: z.number().int(),
  /** Files the suggested resolutions move to holding. */
  extraCopies: z.number().int(),
  reclaimableBytes: z.number(),
});

export const DuplicateSetPageSchema = z.object({
  /** Sets matching the request's scope. */
  total: z.number().int(),
  reclaimableBytes: z.number(),
  counts: z.object({
    exact: z.number().int(),
    similar: z.number().int(),
    variants: z.number().int(),
    dismissed: z.number().int(),
  }),
  /** Bytes resolving every open set would free, identical and similar alike. */
  openReclaimableBytes: z.number(),
  /** Similar sets need fingerprints; how far the analysis has come. */
  fingerprinted: z.number().int(),
  fingerprintable: z.number().int(),
  /**
   * With Spot variants on, how many stills in open similar sets have a detail print to compare
   * by; both zero when it is off.
   */
  compared: z.number().int(),
  comparable: z.number().int(),
  sets: z.array(DuplicateSetSchema),
});

export type DuplicateSetPage = z.infer<typeof DuplicateSetPageSchema>;

export const SimilarityLevelSchema = z.enum(["strict", "balanced", "loose"]);

export type SimilarityLevel = z.infer<typeof SimilarityLevelSchema>;

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
  /** Output size as a share of input size across the sample: the median, then the quartiles. */
  ratio: z.number(),
  ratioLow: z.number(),
  ratioHigh: z.number(),
});

export type OptimizeEstimate = z.infer<typeof OptimizeEstimateSchema>;

/** One video Shrink would re-encode to AV1, with the size it is expected to come out at. */
export const ShrinkItemSchema = z.object({
  fileId: FileIdSchema,
  bytes: z.number(),
  estimatedBytes: z.number(),
  durationMs: z.number(),
  /** Roughly how long the encode takes on an M5 Pro, from its length and picture size. */
  encodeMs: z.number(),
});

export type ShrinkItem = z.infer<typeof ShrinkItemSchema>;

/**
 * The videos under a root that re-encoding to AV1 should shrink, the most bytes saved first, and
 * why the others are left as they are. `preview` holds the first rows, for tiles.
 */
export const ShrinkSummarySchema = z.object({
  items: z.array(ShrinkItemSchema),
  preview: z.array(FileRowSchema),
  skipped: z.array(z.object({ reason: z.string(), files: z.number().int() })),
});

export type ShrinkSummary = z.infer<typeof ShrinkSummarySchema>;

/**
 * The leading items whose originals add up to `limitBytes` without going over, and always at
 * least one; every item when `limitBytes` is null. Shrink's button and its plan both count a
 * batch this way, so they agree.
 */
export function shrinkBatch<T extends { bytes: number }>(
  items: readonly T[],
  limitBytes: number | null,
): T[] {
  if (limitBytes === null) {
    return [...items];
  }

  const batch: T[] = [];
  let total = 0;

  for (const item of items) {
    if (batch.length > 0 && total + item.bytes > limitBytes) {
      break;
    }

    batch.push(item);
    total += item.bytes;
  }

  return batch;
}

/**
 * The Tidy view's to-do list for a root, in the order the work should happen: duplicates, then
 * conversions, then silent soundtracks, then clean-up, then what needs a human look.
 */
export const TidySchema = z.object({
  files: z.number().int(),
  bytes: z.number(),
  lastScanAt: z.number().nullable(),
  duplicates: z.object({ exact: DuplicateTotalsSchema, similar: DuplicateTotalsSchema }),
  convert: OptimizeSummarySchema,
  /** Videos Shrink would re-encode to AV1: how many, their bytes, and the bytes expected after. */
  shrink: z.object({ files: z.number().int(), bytes: z.number(), estimatedBytes: z.number() }),
  /** Videos whose audio track was measured as silent. */
  silentTracks: FacetCountSchema,
  cleanup: z.object({
    junk: z.number().int(),
    emptyFolders: z.number().int(),
    /** Extensions that do not match the bytes, plus AVIF and MP4 under other extensions. */
    extensions: z.number().int(),
  }),
  attention: z.array(FindingSchema),
  analysis: z.object({
    fingerprinted: z.number().int(),
    fingerprintable: z.number().int(),
    soundMeasured: z.number().int(),
    soundMeasurable: z.number().int(),
  }),
});

export type Tidy = z.infer<typeof TidySchema>;

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
  /**
   * Explicit decisions: each group keeps some files and moves others to holding. A group that
   * keeps several files remembers them as not duplicates of each other until the plan is undone,
   * so the set does not come back. A file hard-linked to a kept file is never removed.
   */
  z.object({
    kind: z.literal("resolve-duplicates"),
    groups: z
      .array(
        z.object({
          keep: z.array(FileIdSchema).min(1),
          remove: z.array(FileIdSchema).min(1),
        }),
      )
      .min(1),
  }),
  z.object({ kind: z.literal("clean-junk"), rootId: RootIdSchema }),
  z.object({ kind: z.literal("remove-empty-folders"), rootId: RootIdSchema }),
  /**
   * Junk to holding, empty folders removed, and every extension that does not match its bytes
   * fixed (AVIF and MP4 under other extensions included), as one plan with one undo.
   */
  z.object({ kind: z.literal("cleanup"), rootId: RootIdSchema }),
  /**
   * Re-encodes a root's videos to AV1, the most bytes saved first, until the originals add up to
   * `limitBytes` (every candidate when null). A result that is not at least 5% smaller is thrown
   * away and the video is not offered again until its bytes change.
   */
  z.object({
    kind: z.literal("shrink-videos"),
    rootId: RootIdSchema,
    limitBytes: z.number().positive().nullable(),
  }),
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
  "cleanup",
  "shrink-videos",
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
  /** Bytes the plan moves into holding: removals and the originals conversions replace. */
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
  /** What the plan did, in the past tense: "Converted 206 files", "Resolved 3 duplicate sets". */
  title: z.string(),
  /** What the plan is about, counted: duplicate sets for resolve plans, otherwise its steps. */
  count: z.number().int(),
  steps: z.number().int(),
  done: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  undone: z.number().int(),
  bytesBefore: z.number(),
  bytesAfter: z.number(),
  /** Finished steps that put a file in holding: removals and replaced originals. */
  held: z.object({ files: z.number().int(), bytes: z.number() }),
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
  /** The plan an apply or undo job works on. */
  planId: PlanIdSchema.nullable(),
  /**
   * Analysis queued after a scan. It waits behind, and pauses for, anything the owner asked
   * for, so it never holds up an action.
   */
  background: z.boolean(),
  label: z.string(),
  state: z.enum(["queued", "running", "paused", "done", "failed", "cancelled"]),
  done: z.number(),
  total: z.number(),
  startedAt: z.number(),
  message: z.string().nullable(),
});

export type Job = z.infer<typeof JobSchema>;

export const SettingsSchema = z.object({
  /** Folders whose copies duplicate review keeps first, relative to their root. */
  preferredFolders: z.array(z.object({ rootId: RootIdSchema, dir: z.string() })),
  similarity: SimilarityLevelSchema,
  /**
   * Treat similar stills that differ in one area (a face, an outfit, a caption's language) as
   * pictures of their own: keep each, and pick among the copies of each picture by sound, pixels
   * and the folder holding most of the set.
   */
  spotVariants: z.boolean(),
  /** The quality every re-encode uses, chosen or required by a conversion. */
  reencodeQuality: VideoQualitySchema,
  /** Find similar versions and measure soundtracks in the background after each scan. */
  autoAnalyze: z.boolean(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const EncoderCapabilitiesSchema = z.object({
  /** Hardware or software encoders Chromium's WebCodecs offers on this machine. */
  video: z.object({ avc: z.boolean(), hevc: z.boolean(), av1: z.boolean() }),
  aac: z.boolean(),
  ffmpeg: z.boolean(),
  /** ffmpeg has SVT-AV1, which every AV1 encode uses in place of WebCodecs. */
  svtAv1: z.boolean(),
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
  tidy: method(RootRefSchema, TidySchema),
  listFiles: method(FileQuerySchema, FilePageSchema),
  /** Every matching file's id, in path order, up to `MAX_BULK_FILES`. */
  listFileIds: method(
    FileFilterSchema,
    z.object({ ids: z.array(FileIdSchema), truncated: z.boolean() }),
  ),
  fileFacets: method(FileFilterSchema, FileFacetsSchema),
  getFiles: method(z.object({ ids: z.array(FileIdSchema).max(500) }), z.array(FileRowSchema)),
  selectionSummary: method(
    z.object({ fileIds: z.array(FileIdSchema).max(MAX_BULK_FILES) }),
    SelectionSummarySchema,
  ),
  listFolders: method(RootRefSchema, z.array(z.string())),
  listEmptyFolders: method(RootRefSchema, z.array(z.string())),
  /** Duplicate sets, most bytes to reclaim first. */
  duplicateSets: method(
    OptionalRootRefSchema.extend(PagingSchema.shape).extend({
      level: SimilarityLevelSchema,
      scope: DuplicateScopeSchema,
      /** The sets the owner dismissed, instead of the open ones. */
      dismissed: z.boolean(),
    }),
    DuplicateSetPageSchema,
  ),
  /** Marks files as not duplicates of each other, so a set made only of them stays hidden. */
  dismissDuplicateSet: method(
    z.object({ fileIds: z.array(FileIdSchema).min(2) }),
    z.object({ dismissalId: z.number().int() }),
  ),
  restoreDuplicateSet: method(z.object({ dismissalId: z.number().int() }), NothingSchema),
  analyzeSimilar: method(OptionalRootRefSchema, JobSchema),
  analyzeSound: method(OptionalRootRefSchema, JobSchema),
  optimizeSummary: method(RootRefSchema, OptimizeSummarySchema),
  shrinkSummary: method(RootRefSchema, ShrinkSummarySchema),
  estimateOptimize: method(
    RootRefSchema.extend({ category: OptimizeCategorySchema }),
    OptimizeEstimateSchema,
  ),
  previewPlan: method(PlanRequestSchema, PlanPreviewSchema),
  /**
   * Previews a request and applies it at once. Its warnings say what the change left out or
   * where it went, for the result to report; they never hold it back, since it can be undone.
   */
  perform: method(PlanRequestSchema, z.object({ preview: PlanPreviewSchema, job: JobSchema })),
  applyPlan: method(z.object({ planId: PlanIdSchema }), JobSchema),
  discardPlan: method(z.object({ planId: PlanIdSchema }), NothingSchema),
  listPlans: method(OptionalRootRefSchema.extend(PagingSchema.shape), z.array(PlanSummarySchema)),
  getPlan: method(z.object({ planId: PlanIdSchema }), PlanSummarySchema),
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
