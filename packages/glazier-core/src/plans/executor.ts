import type { BigIntStats, Stats } from "node:fs";
import { lstat, mkdir, readdir, rmdir, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { CatalogDatabase, SqlParams } from "../catalog/database.js";
import { PROBE_VERSION } from "../catalog/file-rows.js";
import {
  FileFormatSchema,
  type HoldingId,
  HoldingIdSchema,
  type PlanId,
  PlanIdSchema,
  type PlanKind,
  PlanKindSchema,
  PlanStatusSchema,
  PlanStepActionSchema,
  type PlanStepPage,
  type PlanSummary,
  type Root,
  type RootId,
  RootIdSchema,
  type TranscodeJob,
} from "../contract.js";
import { removePlanDismissals } from "../duplicates/dismissals.js";
import { formatBytes } from "../format.js";
import { transcodeWithFfmpeg } from "../media/ffmpeg-transcode.js";
import { probeImage } from "../media/image-probe.js";
import { toError } from "../media/run-tool.js";
import type { MediaToolkit } from "../media/toolkit.js";
import { probeVideo } from "../media/video-probe.js";
import type { StillEncoder, Transcoder } from "../optimize/encoders.js";
import { forEachConcurrent } from "../passes/context.js";
import { hashWholeFile } from "../passes/hash-pass.js";
import { isExtensionMismatch } from "../scan/sniff.js";
import { extensionOf, isFolderSystemFile, wholeMs } from "../scan/walk.js";
import {
  type HoldingPlaces,
  holdFile,
  holdingBatchName,
  moveFile,
  pathExists,
  restoreHeld,
} from "./holding.js";
import { isWithin, type StepSpec, StepSpecSchema } from "./planner.js";
import { type PlanSubject, planTitle } from "./wording.js";

/** A conversion is kept only when it saves at least this share of the original's bytes. */
const MINIMUM_SAVING = 0.05;

/**
 * How the plan kinds that keep only a smaller result remember a file that did not shrink, so they
 * stop offering it: Convert and Shrink each keep their own mark.
 */
const NOT_SMALLER_SQL = {
  optimize: "UPDATE files SET optimize_not_smaller = 1 WHERE root_id = $root AND rel_path = $rel",
  "shrink-videos":
    "UPDATE files SET shrink_not_smaller = 1 WHERE root_id = $root AND rel_path = $rel",
} as const satisfies Partial<Record<PlanKind, string>>;

/** How one plan's steps run. */
interface RunContext {
  batch: string;
  /** The statement marking a file the plan could not shrink, or null when it marks none. */
  notSmaller: string | null;
}

/** Holding's reason for a `.DS_Store` or `Thumbs.db` that left with the empty folder it was in. */
const FOLDER_FILES_REASON = "Left by Finder or Explorer in an empty folder";

/** The same reason as 0.1.2 to 0.1.4 wrote it, when only `.DS_Store` left with its folder. */
const FINDER_SETTINGS_REASON = "Finder's settings for an empty folder";

export interface ExecutorDeps {
  db: CatalogDatabase;
  /** Where each root's held files go. */
  places: HoldingPlaces;
  toolkit: MediaToolkit;
  stillEncoder: StillEncoder;
  transcoder: Transcoder;
  roots: readonly Root[];
  /** AVIF encodes run this many at once. */
  stillConcurrency: number;
  /** ffmpeg has SVT-AV1, so AV1 encodes run there rather than on WebCodecs. */
  svtAv1: boolean;
  signal: AbortSignal;
  checkpoint: () => Promise<void>;
  progress: (update: { done: number; total: number; label: string }) => void;
}

const StepRecordSchema = z.object({
  id: z.number(),
  plan_id: PlanIdSchema,
  action: PlanStepActionSchema,
  root_id: RootIdSchema,
  root_path: z.string(),
  from_rel: z.string(),
  to_abs: z.string().nullable(),
  spec: z.string().transform((json) => StepSpecSchema.parse(JSON.parse(json))),
  expected_size: z.number(),
  expected_mtime_ms: z.number(),
  expected_ctime_ms: z.number(),
  status: z.enum(["pending", "done", "skipped", "failed", "undone"]),
  message: z.string().nullable(),
  bytes_before: z.number(),
  bytes_after: z.number().nullable(),
  holding_id: HoldingIdSchema.nullable(),
});

type StepRecord = z.infer<typeof StepRecordSchema>;

const STEP_COLUMNS = `s.id, s.plan_id, s.action, s.root_id, r.path AS root_path, s.from_rel, s.to_abs,
  s.spec, s.expected_size, s.expected_mtime_ms, s.expected_ctime_ms, s.status, s.message,
  s.bytes_before, s.bytes_after, s.holding_id`;

/** How one step ended. */
type StepOutcome =
  | { kind: "done"; bytesAfter: number; holdingId: HoldingId | null; message: string | null }
  | { kind: "skipped"; message: string }
  | { kind: "failed"; message: string };

class StepSkip extends Error {
  override readonly name = "StepSkip";
}

/** A skip because the catalog is out of date for the file: a scan has to catch it up first. */
class StaleSourceSkip extends StepSkip {}

/** What applying a plan left for the engine to follow up. */
export interface ApplyResult {
  /** Steps skipped because their file changed or vanished since the scan. */
  staleSteps: number;
}

function loadSteps(
  db: CatalogDatabase,
  planId: PlanId,
  status: string,
  order: "ASC" | "DESC",
): StepRecord[] {
  return db.all(
    `SELECT ${STEP_COLUMNS} FROM plan_steps s JOIN roots r ON r.id = s.root_id
      WHERE s.plan_id = $plan AND s.status = $status ORDER BY s.id ${order}`,
    StepRecordSchema,
    { $plan: planId, $status: status },
  );
}

function fromAbs(step: StepRecord): string {
  return path.join(step.root_path, ...step.from_rel.split("/"));
}

/** The root a path lies in, with the path relative to it; null outside every root. */
function locate(
  roots: readonly Root[],
  absPath: string,
): { rootId: RootId; relPath: string } | null {
  const root = roots
    .filter((candidate) => isWithin(absPath, candidate.path))
    .sort((left, right) => right.path.length - left.path.length)[0];

  if (!root) {
    return null;
  }

  return { rootId: root.id, relPath: path.relative(root.path, absPath).split(path.sep).join("/") };
}

const CHANGED_SINCE_SCAN = "The file changed since the scan; rescan before changing it.";

/**
 * Re-reads the source just before touching it. A file that changed since the scan (size, mtime
 * or ctime) or vanished is skipped, never acted on from stale facts. When only the ctime moved,
 * as when a sync client such as Tresorit tags a file it sees arrive, the bytes decide: a file
 * that still hashes to the catalog's SHA-256 is the file the plan was drafted for.
 */
async function checkSource(deps: ExecutorDeps, step: StepRecord): Promise<Stats> {
  let current: BigIntStats;

  try {
    current = await lstat(fromAbs(step), { bigint: true });
  } catch {
    throw new StaleSourceSkip("The file is no longer there.");
  }

  if (
    !current.isFile() ||
    Number(current.size) !== step.expected_size ||
    wholeMs(current.mtimeNs) !== Math.trunc(step.expected_mtime_ms)
  ) {
    throw new StaleSourceSkip(CHANGED_SINCE_SCAN);
  }

  if (
    wholeMs(current.ctimeNs) !== Math.trunc(step.expected_ctime_ms) &&
    !(await holdsCataloguedBytes(deps, step, current))
  ) {
    throw new StaleSourceSkip(CHANGED_SINCE_SCAN);
  }

  return lstat(fromAbs(step));
}

/** Whether the file still hashes to the SHA-256 the catalog has for it; false without one. */
async function holdsCataloguedBytes(
  deps: ExecutorDeps,
  step: StepRecord,
  current: BigIntStats,
): Promise<boolean> {
  const row = deps.db.get(
    "SELECT sha256 FROM files WHERE root_id = $root AND rel_path = $rel",
    z.object({ sha256: z.string().nullable() }),
    { $root: step.root_id, $rel: step.from_rel },
  );

  if (row?.sha256 == null) {
    return false;
  }

  const sha256 = await hashWholeFile(
    fromAbs(step),
    {
      size: Number(current.size),
      mtimeMs: wholeMs(current.mtimeNs),
      ctimeMs: wholeMs(current.ctimeNs),
    },
    deps.signal,
  ).catch(() => null);

  return sha256 === row.sha256;
}

function dirOf(relPath: string): string {
  const index = relPath.lastIndexOf("/");

  return index < 0 ? "" : relPath.slice(0, index);
}

function baseOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

/** Points a catalog row at a file's new path when the bytes did not change (move, rename). */
async function relocateRow(deps: ExecutorDeps, step: StepRecord, target: string): Promise<void> {
  const located = locate(deps.roots, target);

  if (located === null) {
    deps.db.run("DELETE FROM files WHERE root_id = $root AND rel_path = $rel", {
      $root: step.root_id,
      $rel: step.from_rel,
    });

    return;
  }

  const moved = await stat(target, { bigint: true });
  const name = baseOf(located.relPath);
  const ext = extensionOf(name);

  deps.db.run(
    `UPDATE files SET root_id = $newRoot, rel_path = $rel, dir = $dir, name = $name, ext = $ext,
      ctime_ms = $ctime, dev = $dev, ino = $ino,
      ext_mismatch = CASE WHEN format IS NULL THEN 0 ELSE $mismatchProbe END
      WHERE root_id = $root AND rel_path = $from`,
    {
      $newRoot: located.rootId,
      $rel: located.relPath,
      $dir: dirOf(located.relPath),
      $name: name,
      $ext: ext,
      $ctime: wholeMs(moved.ctimeNs),
      $dev: moved.dev.toString(),
      $ino: moved.ino.toString(),
      $mismatchProbe: await mismatchFor(deps, step, ext),
      $root: step.root_id,
      $from: step.from_rel,
    },
  );
}

async function mismatchFor(deps: ExecutorDeps, step: StepRecord, ext: string): Promise<number> {
  const row = deps.db.get(
    "SELECT format FROM files WHERE root_id = $root AND rel_path = $rel",
    z.object({ format: FileFormatSchema.nullable() }),
    { $root: step.root_id, $rel: step.from_rel },
  );

  return row?.format != null && isExtensionMismatch(row.format, ext) ? 1 : 0;
}

interface OutputFacts {
  format: string;
  kind: "image" | "video";
  width: number | null;
  height: number | null;
  frames: number | null;
  durationMs: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioStreams: number | null;
  bitrate: number | null;
}

/**
 * Rewrites a catalog row for a converted file: new path, new bytes, the facts just verified. A
 * conversion that copied the audio track keeps the track's loudness measurement.
 */
async function replaceRow(
  deps: ExecutorDeps,
  step: StepRecord,
  target: string,
  output: { facts: OutputFacts; keepLoudness: boolean },
) {
  const { facts } = output;
  const located = locate(deps.roots, target);

  if (located === null) {
    return;
  }

  const written = await stat(target, { bigint: true });
  const name = baseOf(located.relPath);

  deps.db.run(
    `UPDATE files SET rel_path = $rel, dir = $dir, name = $name, ext = $ext, size = $size,
      mtime_ms = $mtime, ctime_ms = $ctime, dev = $dev, ino = $ino, kind = $kind, format = $format,
      ext_mismatch = 0, probe_version = $probe, probe_error = NULL, width = $width,
      height = $height, frames = $frames, duration_ms = $duration, video_codec = $video,
      audio_codec = $audio, audio_streams = $streams, bitrate = $bitrate, head_hash = NULL,
      sha256 = NULL, fingerprint_version = 0, fingerprint = NULL, fingerprint_error = NULL,
      loudness_version = CASE WHEN $keepLoudness = 1 THEN loudness_version ELSE 0 END,
      loudness_max_db = CASE WHEN $keepLoudness = 1 THEN loudness_max_db ELSE NULL END,
      optimize_not_smaller = 0, shrink_not_smaller = 0
      WHERE root_id = $root AND rel_path = $from`,
    {
      $rel: located.relPath,
      $dir: dirOf(located.relPath),
      $name: name,
      $ext: extensionOf(name),
      $size: Number(written.size),
      $mtime: wholeMs(written.mtimeNs),
      $ctime: wholeMs(written.ctimeNs),
      $dev: written.dev.toString(),
      $ino: written.ino.toString(),
      $kind: facts.kind,
      $format: facts.format,
      $probe: PROBE_VERSION,
      $width: facts.width,
      $height: facts.height,
      $frames: facts.frames,
      $duration: facts.durationMs,
      $video: facts.videoCodec,
      $audio: facts.audioCodec,
      $streams: facts.audioStreams,
      $bitrate: facts.bitrate,
      $keepLoudness: output.keepLoudness ? 1 : 0,
      $root: step.root_id,
      $from: step.from_rel,
    },
  );
}

interface SourceFacts {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  audioStreams: number | null;
}

function sourceFacts(deps: ExecutorDeps, step: StepRecord): SourceFacts {
  return (
    deps.db.get(
      `SELECT width, height, duration_ms AS durationMs, audio_streams AS audioStreams FROM files
        WHERE root_id = $root AND rel_path = $rel`,
      z.object({
        width: z.number().nullable(),
        height: z.number().nullable(),
        durationMs: z.number().nullable(),
        audioStreams: z.number().nullable(),
      }),
      { $root: step.root_id, $rel: step.from_rel },
    ) ?? { width: null, height: null, durationMs: null, audioStreams: null }
  );
}

function closeTo(actual: number | null, expected: number | null, tolerance: number): boolean {
  return actual !== null && expected !== null && Math.abs(actual - expected) <= tolerance;
}

/** How one conversion runs and what it records. */
interface ConvertContext {
  batch: string;
  source: Stats;
  /** Keep the result only when it saves at least {@link MINIMUM_SAVING}. */
  requireSmaller: boolean;
  /** Marks a file whose result was not kept for that, so it is not offered again; or null. */
  notSmaller: string | null;
  /** The result carries the original's audio track unchanged. */
  keepLoudness: boolean;
}

/**
 * Writes a conversion to a temp file, checks it with `verify`, gives it the original's
 * modification time, puts it in place and moves the original to holding. When the target is the
 * original's own path (re-encoding an MP4), the original leaves first.
 */
async function convert(
  deps: ExecutorDeps,
  step: StepRecord,
  context: ConvertContext,
  produce: (tempPath: string) => Promise<string | null>,
  verify: (tempPath: string) => Promise<OutputFacts>,
): Promise<StepOutcome> {
  const target = step.to_abs;

  if (target === null) {
    return { kind: "failed", message: "The step has no target." };
  }

  const source = fromAbs(step);
  const samePath = path.resolve(target) === path.resolve(source);

  if (!samePath && (await pathExists(target))) {
    return { kind: "skipped", message: `${path.basename(target)} already exists.` };
  }

  const tempPath = `${target}.glazier-tmp`;

  try {
    const note = await produce(tempPath);
    const facts = await verify(tempPath);
    const written = await stat(tempPath);

    if (context.requireSmaller && written.size > context.source.size * (1 - MINIMUM_SAVING)) {
      await unlink(tempPath);

      if (context.notSmaller !== null) {
        deps.db.run(context.notSmaller, { $root: step.root_id, $rel: step.from_rel });
      }

      const why =
        written.size > context.source.size ? "the result was larger" : "it saved less than 5%";

      return {
        kind: "skipped",
        message: `Kept the original: ${why} (${formatBytes(context.source.size)} → ${formatBytes(written.size)})`,
      };
    }

    await utimes(tempPath, context.source.atime, context.source.mtime);

    const hold = () =>
      holdFile(deps, {
        rootId: step.root_id,
        rootPath: step.root_path,
        relPath: step.from_rel,
        batch: context.batch,
        planId: step.plan_id,
        reason: `Replaced by ${path.basename(target)}`,
      });

    let holdingId: HoldingId;

    if (samePath) {
      holdingId = await hold();

      try {
        await moveFile(tempPath, target);
      } catch (error) {
        await restoreHeld(deps.db, holdingId);

        throw error;
      }
    } else {
      await moveFile(tempPath, target);
      holdingId = await hold();
    }

    await replaceRow(deps, step, target, { facts, keepLoudness: context.keepLoudness });

    return { kind: "done", bytesAfter: written.size, holdingId, message: note };
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function executeStep(
  deps: ExecutorDeps,
  step: StepRecord,
  run: RunContext,
): Promise<StepOutcome> {
  const spec: StepSpec = step.spec;
  const { batch } = run;

  if (spec.kind === "remove-folder") {
    const folder = fromAbs(step);
    const entries = await readdir(folder).catch(() => null);

    if (entries === null) {
      return { kind: "skipped", message: "The folder is no longer there." };
    }

    // Finder's and Explorer's files are not catalogued, so they go to holding with their folder.
    const systemFiles = entries.filter(isFolderSystemFile);

    if (entries.length > systemFiles.length) {
      return { kind: "skipped", message: "The folder is no longer empty." };
    }

    for (const name of systemFiles) {
      await holdFile(deps, {
        rootId: step.root_id,
        rootPath: step.root_path,
        relPath: `${step.from_rel}/${name}`,
        batch,
        planId: step.plan_id,
        reason: FOLDER_FILES_REASON,
      });
    }

    await rmdir(folder);
    deps.db.run("DELETE FROM empty_folders WHERE root_id = $root AND rel_path = $rel", {
      $root: step.root_id,
      $rel: step.from_rel,
    });

    return { kind: "done", bytesAfter: 0, holdingId: null, message: null };
  }

  const source = await checkSource(deps, step);

  switch (spec.kind) {
    case "hold": {
      const holdingId = await holdFile(deps, {
        rootId: step.root_id,
        rootPath: step.root_path,
        relPath: step.from_rel,
        batch,
        planId: step.plan_id,
        reason: spec.reason,
      });

      deps.db.run("DELETE FROM files WHERE root_id = $root AND rel_path = $rel", {
        $root: step.root_id,
        $rel: step.from_rel,
      });

      return { kind: "done", bytesAfter: 0, holdingId, message: null };
    }

    case "move":
    case "rename": {
      const target = step.to_abs;

      if (target === null) {
        return { kind: "failed", message: "The step has no target." };
      }

      if (path.resolve(target) !== path.resolve(fromAbs(step)) && (await pathExists(target))) {
        return { kind: "skipped", message: `${path.basename(target)} already exists there.` };
      }

      await moveFile(fromAbs(step), target);
      await relocateRow(deps, step, target);

      return { kind: "done", bytesAfter: source.size, holdingId: null, message: null };
    }

    case "convert-avif": {
      const expected = sourceFacts(deps, step);

      return convert(
        deps,
        step,
        {
          batch,
          source,
          requireSmaller: true,
          notSmaller: run.notSmaller,
          keepLoudness: false,
        },
        async (tempPath) => {
          const result = await deps.stillEncoder.encode(
            { srcPath: fromAbs(step), outPath: tempPath },
            deps.signal,
          );

          return result.encoder === "sharp" ? "Encoded with sharp: over 64 megapixels" : null;
        },
        async (tempPath) => {
          const probe = await probeImage(deps.toolkit.sharp, tempPath);

          if (
            !closeTo(probe.width, expected.width, 1) ||
            !closeTo(probe.height, expected.height, 1)
          ) {
            throw new Error(
              `The AVIF came out ${probe.width}×${probe.height}, not ${expected.width}×${expected.height}.`,
            );
          }

          return {
            format: "avif",
            kind: "image",
            width: probe.width,
            height: probe.height,
            frames: 1,
            durationMs: null,
            videoCodec: null,
            audioCodec: null,
            audioStreams: null,
            bitrate: null,
          };
        },
      );
    }

    case "convert-animation":
    case "convert-video": {
      const ffprobePath = deps.toolkit.ffprobePath;

      if (ffprobePath === null) {
        return {
          kind: "failed",
          message: "ffprobe is unavailable, so the result cannot be checked.",
        };
      }

      const expected = sourceFacts(deps, step);
      const animation = spec.kind === "convert-animation";
      const probePath: string = ffprobePath;

      const jobFor = (tempPath: string): TranscodeJob =>
        spec.kind === "convert-animation"
          ? {
              kind: "animation",
              srcPath: fromAbs(step),
              outPath: tempPath,
              mimeType: spec.mimeType,
            }
          : {
              kind: "video",
              srcPath: fromAbs(step),
              outPath: tempPath,
              video: spec.video,
              audio: spec.audio,
              quality: spec.quality,
            };

      // AV1 goes to SVT-AV1 when ffmpeg has it: at the same size it keeps more of the picture
      // than the realtime libaom encoder WebCodecs runs.
      const ffmpegPath = deps.toolkit.ffmpegPath;

      if (
        deps.svtAv1 &&
        ffmpegPath !== null &&
        spec.kind === "convert-video" &&
        spec.video.action === "encode" &&
        spec.video.codec === "av1"
      ) {
        return convert(
          deps,
          step,
          {
            batch,
            source,
            requireSmaller: spec.requireSmaller,
            notSmaller: run.notSmaller,
            keepLoudness: spec.audio.action === "copy",
          },
          async (tempPath) => {
            await transcodeWithFfmpeg(ffmpegPath, jobFor(tempPath), deps.signal);

            return "Encoded with SVT-AV1";
          },
          verifyVideo,
        );
      }

      let mediabunnyResult = false;

      const attempt = (produce: (tempPath: string) => Promise<string | null>) =>
        convert(
          deps,
          step,
          {
            batch,
            source,
            requireSmaller: animation || spec.requireSmaller,
            notSmaller: run.notSmaller,
            keepLoudness: spec.kind === "convert-video" && spec.audio.action === "copy",
          },
          produce,
          verifyVideo,
        );

      try {
        return await attempt(async (tempPath) => {
          const outcome = await deps.transcoder.transcode(
            jobFor(tempPath),
            deps.signal,
            () => undefined,
          );

          mediabunnyResult = outcome.via === "mediabunny";

          return outcome.note;
        });
      } catch (error) {
        // Mediabunny wrote a file that failed the check: give ffmpeg one go at the same job.
        if (!mediabunnyResult || ffmpegPath === null || deps.signal.aborted) {
          throw error;
        }

        const reason = toError(error).message;

        return attempt(async (tempPath) => {
          await transcodeWithFfmpeg(ffmpegPath, jobFor(tempPath), deps.signal);

          return `Converted with ffmpeg (Mediabunny's result: ${reason})`;
        });
      }

      async function verifyVideo(tempPath: string): Promise<OutputFacts> {
        const probe = await probeVideo(probePath, tempPath);

        const durationTolerance = Math.max(
          animation ? 250 : 500,
          (expected.durationMs ?? 0) * 0.02,
        );

        if (probe.videoCodec === null) {
          throw new Error("The result has no video track.");
        }

        if (!closeTo(probe.durationMs, expected.durationMs, durationTolerance)) {
          throw new Error(
            `The result lasts ${probe.durationMs} ms instead of ${expected.durationMs} ms.`,
          );
        }

        if (
          !closeTo(probe.width, expected.width, 2) ||
          !closeTo(probe.height, expected.height, 2)
        ) {
          throw new Error(
            `The result is ${probe.width}×${probe.height}, not ${expected.width}×${expected.height}.`,
          );
        }

        const droppedAudio = spec.kind === "convert-video" && spec.audio.action === "drop";

        if (droppedAudio && probe.audioStreams > 0) {
          throw new Error("The result still has audio.");
        }

        if (
          !animation &&
          !droppedAudio &&
          (expected.audioStreams ?? 0) > 0 &&
          probe.audioStreams === 0
        ) {
          throw new Error("The result lost its audio.");
        }

        return {
          format: "mp4",
          kind: "video",
          width: probe.width,
          height: probe.height,
          frames: null,
          durationMs: probe.durationMs,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          audioStreams: probe.audioStreams,
          bitrate: probe.bitrate,
        };
      }
    }

    default: {
      const _exhaustive: never = spec;

      return _exhaustive;
    }
  }
}

function recordOutcome(db: CatalogDatabase, stepId: number, outcome: StepOutcome): void {
  if (outcome.kind === "done") {
    db.run(
      `UPDATE plan_steps SET status = 'done', message = $message, bytes_after = $bytes,
        holding_id = $holding, done_at = $now WHERE id = $id`,
      {
        $message: outcome.message,
        $bytes: outcome.bytesAfter,
        $holding: outcome.holdingId,
        $now: Date.now(),
        $id: stepId,
      },
    );

    return;
  }

  db.run("UPDATE plan_steps SET status = $status, message = $message WHERE id = $id", {
    $status: outcome.kind,
    $message: outcome.message,
    $id: stepId,
  });
}

const StatusCountsSchema = z.object({
  pending: z.number().nullable(),
  failed: z.number().nullable(),
  done: z.number().nullable(),
});

function settlePlan(db: CatalogDatabase, planId: PlanId, cancelled: boolean): void {
  const counts = db.get(
    `SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed,
      SUM(status = 'done') AS done FROM plan_steps WHERE plan_id = $plan`,
    StatusCountsSchema,
    { $plan: planId },
  );

  const status = cancelled
    ? "cancelled"
    : (counts?.failed ?? 0) === 0
      ? "applied"
      : (counts?.done ?? 0) === 0
        ? "failed"
        : "partial";

  db.run("UPDATE plans SET status = $status WHERE id = $plan", { $status: status, $plan: planId });
}

/**
 * Applies a reviewed plan. AVIF encodes run in parallel; every other step runs in order, so a
 * folder's junk leaves before the folder does. Each step settles on its own: one failure never
 * stops the rest, and a cancelled run leaves the remaining steps pending.
 */
export async function applyPlan(deps: ExecutorDeps, planId: PlanId): Promise<ApplyResult> {
  deps.db.run("UPDATE plans SET status = 'applying' WHERE id = $plan", { $plan: planId });

  const steps = loadSteps(deps.db, planId, "pending", "ASC");
  const batch = holdingBatchName(planId, new Date());
  const kind = planSubject(deps.db, planId)?.kind;

  const notSmaller = kind === "optimize" || kind === "shrink-videos" ? NOT_SMALLER_SQL[kind] : null;

  let done = 0;
  let staleSteps = 0;

  const run = async (step: StepRecord) => {
    let outcome: StepOutcome;

    try {
      outcome = await executeStep(deps, step, { batch, notSmaller });
    } catch (error) {
      if (deps.signal.aborted) {
        throw error;
      }

      if (error instanceof StaleSourceSkip) {
        staleSteps += 1;
      }

      outcome =
        error instanceof StepSkip
          ? { kind: "skipped", message: error.message }
          : { kind: "failed", message: toError(error).message };
    }

    recordOutcome(deps.db, step.id, outcome);
    done += 1;
    deps.progress({ done, total: steps.length, label: describeAction(step.action) });
  };

  try {
    await forEachConcurrent(
      steps.filter((step) => step.action === "convert-avif"),
      deps.stillConcurrency,
      deps.checkpoint,
      run,
    );

    for (const step of steps) {
      if (step.action !== "convert-avif") {
        await deps.checkpoint();
        await run(step);
      }
    }

    settlePlan(deps.db, planId, false);
  } catch (error) {
    settlePlan(deps.db, planId, deps.signal.aborted);

    throw error;
  }

  return { staleSteps };
}

function describeAction(action: StepRecord["action"]): string {
  const labels = {
    hold: "Moving files to holding",
    move: "Moving files",
    rename: "Renaming files",
    "convert-avif": "Converting stills to AVIF",
    "convert-animation": "Converting animations to MP4",
    "convert-video": "Converting videos to MP4",
    "remove-folder": "Removing empty folders",
  } as const satisfies Record<StepRecord["action"], string>;

  return labels[action];
}

/**
 * Reverses a plan's finished steps, newest first: held files come back, moved files move back, a
 * converted file goes to holding and its original returns. A step whose result was changed since
 * is left alone and reported.
 */
export async function undoPlan(deps: ExecutorDeps, planId: PlanId): Promise<void> {
  const steps = loadSteps(deps.db, planId, "done", "DESC");
  const batch = holdingBatchName(planId, new Date());
  let done = 0;

  for (const step of steps) {
    await deps.checkpoint();

    try {
      await undoStep(deps, step, batch);
      deps.db.run("UPDATE plan_steps SET status = 'undone', undone_at = $now WHERE id = $id", {
        $now: Date.now(),
        $id: step.id,
      });
    } catch (error) {
      deps.db.run("UPDATE plan_steps SET message = $message WHERE id = $id", {
        $message: `Undo failed: ${toError(error).message}`,
        $id: step.id,
      });
    }

    done += 1;
    deps.progress({ done, total: steps.length, label: "Undoing" });
  }

  removePlanDismissals(deps.db, planId);
  deps.db.run("UPDATE plans SET status = 'undone' WHERE id = $plan", { $plan: planId });
}

async function undoStep(deps: ExecutorDeps, step: StepRecord, batch: string): Promise<void> {
  switch (step.action) {
    case "hold":
      if (step.holding_id !== null) {
        await restoreHeld(deps.db, step.holding_id);
      }

      return;
    case "move":
    case "rename": {
      if (step.to_abs === null) {
        return;
      }

      const current = await stat(step.to_abs);

      if (current.size !== step.expected_size) {
        throw new Error("The moved file has changed since.");
      }

      if (await pathExists(fromAbs(step))) {
        throw new Error("Something now exists at the original path.");
      }

      await moveFile(step.to_abs, fromAbs(step));

      return;
    }

    case "convert-avif":
    case "convert-animation":
    case "convert-video": {
      if (step.to_abs === null || step.holding_id === null) {
        return;
      }

      const output = await stat(step.to_abs).catch(() => null);

      if (output !== null) {
        if (output.size !== step.bytes_after) {
          throw new Error("The converted file has changed since.");
        }

        const located = locate(deps.roots, step.to_abs);

        if (located === null) {
          throw new Error("The converted file is outside every root.");
        }

        await holdFile(deps, {
          rootId: located.rootId,
          rootPath: step.root_path,
          relPath: located.relPath,
          batch,
          planId: step.plan_id,
          reason: "Undone conversion",
        });
      }

      await restoreHeld(deps.db, step.holding_id);

      return;
    }

    case "remove-folder": {
      await mkdir(fromAbs(step), { recursive: true });

      const held = deps.db.all(
        `SELECT id, original_rel FROM holding
          WHERE plan_id = $plan AND root_id = $root AND state = 'held'
            AND reason IN ($reason, $finderReason)`,
        z.object({ id: HoldingIdSchema, original_rel: z.string() }),
        {
          $plan: step.plan_id,
          $root: step.root_id,
          $reason: FOLDER_FILES_REASON,
          $finderReason: FINDER_SETTINGS_REASON,
        },
      );

      for (const record of held) {
        if (dirOf(record.original_rel) === step.from_rel) {
          // Finder or Explorer may have written fresh files into the folder already; those win.
          await restoreHeld(deps.db, record.id).catch(() => undefined);
        }
      }

      return;
    }

    default: {
      const _exhaustive: never = step.action;

      return _exhaustive;
    }
  }
}

/**
 * After a crash or quit mid-apply, a plan can be left `applying` with temp files beside its
 * targets. Those plans become `cancelled` and their temp files are removed.
 */
export async function recoverInterruptedPlans(db: CatalogDatabase): Promise<void> {
  const interrupted = db.all(
    "SELECT id FROM plans WHERE status = 'applying'",
    z.object({ id: PlanIdSchema }),
  );

  for (const { id } of interrupted) {
    const targets = db.all(
      "SELECT to_abs FROM plan_steps WHERE plan_id = $plan AND status = 'pending' AND to_abs IS NOT NULL",
      z.object({ to_abs: z.string() }),
      { $plan: id },
    );

    for (const { to_abs } of targets) {
      await unlink(`${to_abs}.glazier-tmp`).catch(() => undefined);
    }

    db.run("UPDATE plans SET status = 'cancelled' WHERE id = $plan", { $plan: id });
  }
}

const PlanRowSchema = z.object({
  id: PlanIdSchema,
  kind: PlanKindSchema,
  created_at: z.number(),
  status: PlanStatusSchema,
  count: z.number(),
  steps: z.number(),
  done: z.number().nullable(),
  skipped: z.number().nullable(),
  failed: z.number().nullable(),
  undone: z.number().nullable(),
  bytes_before: z.number().nullable(),
  bytes_after: z.number().nullable(),
  held_files: z.number().nullable(),
  held_bytes: z.number().nullable(),
  first_from: z.string().nullable(),
});

type PlanRow = z.infer<typeof PlanRowSchema>;

const PLAN_SUMMARY_SQL = `SELECT p.id, p.kind, p.created_at, p.status, p.count, COUNT(s.id) AS steps,
    SUM(s.status = 'done') AS done, SUM(s.status = 'skipped') AS skipped,
    SUM(s.status = 'failed') AS failed, SUM(s.status = 'undone') AS undone,
    SUM(CASE WHEN s.status = 'done' THEN s.bytes_before ELSE 0 END) AS bytes_before,
    SUM(CASE WHEN s.status = 'done' THEN COALESCE(s.bytes_after, 0) ELSE 0 END) AS bytes_after,
    SUM(s.status = 'done' AND s.holding_id IS NOT NULL) AS held_files,
    SUM(CASE WHEN s.status = 'done' AND s.holding_id IS NOT NULL THEN s.bytes_before ELSE 0 END)
      AS held_bytes,
    MIN(s.from_rel) AS first_from
  FROM plans p LEFT JOIN plan_steps s ON s.plan_id = p.id`;

/** Plan kinds whose `count` is their steps, so a partial run can say how many finished. */
const COUNTS_STEPS = new Set<PlanKind>([
  "hold",
  "move",
  "rename",
  "fix-extension",
  "optimize",
  "reencode",
  "strip-audio",
  "clean-junk",
  "cleanup",
  "shrink-videos",
]);

function subjectOf(
  row: Pick<PlanRow, "kind" | "count" | "first_from" | "status" | "done">,
): PlanSubject {
  const cutShort =
    (row.status === "partial" || row.status === "failed" || row.status === "cancelled") &&
    COUNTS_STEPS.has(row.kind) &&
    (row.done ?? 0) < row.count;

  return {
    kind: row.kind,
    count: row.count,
    singleName: row.first_from === null ? null : baseOf(row.first_from),
    finished: cutShort ? (row.done ?? 0) : null,
  };
}

function toPlanSummary(row: PlanRow): PlanSummary {
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    status: row.status,
    title: planTitle(subjectOf(row)),
    count: row.count,
    steps: row.steps,
    done: row.done ?? 0,
    skipped: row.skipped ?? 0,
    failed: row.failed ?? 0,
    undone: row.undone ?? 0,
    bytesBefore: row.bytes_before ?? 0,
    bytesAfter: row.bytes_after ?? 0,
    held: { files: row.held_files ?? 0, bytes: row.held_bytes ?? 0 },
  };
}

export function listPlans(
  db: CatalogDatabase,
  page: { rootId: RootId | null; offset: number; limit: number },
): PlanSummary[] {
  const rootFilter =
    page.rootId === null
      ? ""
      : "AND p.id IN (SELECT plan_id FROM plan_steps WHERE root_id = $root)";

  const params: SqlParams = { $limit: page.limit, $offset: page.offset };

  if (page.rootId !== null) {
    params.$root = page.rootId;
  }

  return db
    .all(
      `${PLAN_SUMMARY_SQL}
        WHERE p.status != 'draft' ${rootFilter}
        GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC LIMIT $limit OFFSET $offset`,
      PlanRowSchema,
      params,
    )
    .map(toPlanSummary);
}

/** One plan, whatever its status, or null when there is no such plan. */
export function getPlan(db: CatalogDatabase, planId: PlanId): PlanSummary | null {
  const row = db.get(`${PLAN_SUMMARY_SQL} WHERE p.id = $plan GROUP BY p.id`, PlanRowSchema, {
    $plan: planId,
  });

  return row === null ? null : toPlanSummary(row);
}

const SubjectRowSchema = PlanRowSchema.pick({
  kind: true,
  count: true,
  first_from: true,
  status: true,
  done: true,
});

/** What a plan is about, for its title and job labels. */
export function planSubject(db: CatalogDatabase, planId: PlanId): PlanSubject | null {
  const row = db.get(
    `SELECT p.kind, p.count, p.status, MIN(s.from_rel) AS first_from,
        SUM(s.status = 'done') AS done
      FROM plans p LEFT JOIN plan_steps s ON s.plan_id = p.id WHERE p.id = $plan GROUP BY p.id`,
    SubjectRowSchema,
    { $plan: planId },
  );

  return row === null ? null : subjectOf(row);
}

export function listPlanSteps(
  db: CatalogDatabase,
  page: { planId: PlanId; offset: number; limit: number },
): PlanStepPage {
  const total =
    db.get(
      "SELECT COUNT(*) AS total FROM plan_steps WHERE plan_id = $plan",
      z.object({ total: z.number() }),
      {
        $plan: page.planId,
      },
    )?.total ?? 0;

  const steps = db.all(
    `SELECT ${STEP_COLUMNS} FROM plan_steps s JOIN roots r ON r.id = s.root_id
      WHERE s.plan_id = $plan ORDER BY s.id LIMIT $limit OFFSET $offset`,
    StepRecordSchema,
    { $plan: page.planId, $limit: page.limit, $offset: page.offset },
  );

  return {
    total,
    steps: steps.map((step) => ({
      id: step.id,
      action: step.action,
      fromPath: fromAbs(step),
      toPath: step.to_abs,
      status: step.status,
      message: step.message,
      bytesBefore: step.bytes_before,
      bytesAfter: step.bytes_after,
    })),
  };
}

export function discardDraft(db: CatalogDatabase, planId: PlanId): void {
  db.run("DELETE FROM plans WHERE id = $plan AND status = 'draft'", { $plan: planId });
}

export function planRootIds(db: CatalogDatabase, planId: PlanId): RootId[] {
  return db
    .all(
      "SELECT DISTINCT root_id FROM plan_steps WHERE plan_id = $plan",
      z.object({ root_id: RootIdSchema }),
      {
        $plan: planId,
      },
    )
    .map((row) => row.root_id);
}
