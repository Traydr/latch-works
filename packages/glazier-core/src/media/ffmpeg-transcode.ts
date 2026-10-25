import type { TranscodeJob, VideoQuality } from "../contract.js";
import type { TranscodeOutcome, Transcoder } from "../optimize/encoders.js";
import { isAbortError, runTool, toError } from "./run-tool.js";

/** A long video re-encoded in software takes a while; this bounds a hung ffmpeg, not a slow one. */
const TRANSCODE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Constant-rate-factor per encoder and quality: lower is better and larger. AV1's "high" is CRF
 * 35, the balance of size and picture the owner chose from side-by-side encodes of the library.
 */
const CRF = {
  avc: { medium: 23, high: 20, "very-high": 17 },
  hevc: { medium: 28, high: 24, "very-high": 21 },
  av1: { medium: 40, high: 35, "very-high": 30 },
} as const satisfies Record<"avc" | "hevc" | "av1", Record<VideoQuality, number>>;

/**
 * H.264 and HEVC take only even frame sizes, so an odd-sized source loses its last pixel row or
 * column, as on the Mediabunny path.
 */
const EVEN_SIZE_FILTER = "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0";

function videoArgs(job: Extract<TranscodeJob, { kind: "video" }>): string[] {
  switch (job.video.action) {
    case "copy":
      return ["-c:v", "copy"];
    case "encode": {
      const crf = String(CRF[job.video.codec][job.quality]);
      const common = ["-vf", EVEN_SIZE_FILTER, "-crf", crf];
      const eightBit = ["-pix_fmt", "yuv420p"];

      switch (job.video.codec) {
        case "avc":
          return ["-c:v", "libx264", "-preset", "medium", ...eightBit, ...common];
        case "hevc":
          // `hvc1` is the tag Apple players need to play HEVC in MP4.
          return ["-c:v", "libx265", "-preset", "medium", "-tag:v", "hvc1", ...eightBit, ...common];
        case "av1":
          // SVT-AV1 takes 8- and 10-bit 4:2:0, so a 10-bit (HDR) source stays 10-bit, and its
          // colour tags carry over.
          return ["-c:v", "libsvtav1", "-preset", "6", ...common];
        default: {
          const _exhaustive: never = job.video.codec;

          return _exhaustive;
        }
      }
    }

    default: {
      const _exhaustive: never = job.video;

      return _exhaustive;
    }
  }
}

function audioArgs(job: Extract<TranscodeJob, { kind: "video" }>): string[] {
  switch (job.audio.action) {
    case "copy":
      return ["-map", "0:a:0?", "-c:a", "copy"];
    case "encode-aac":
      return ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k"];
    case "drop":
      return ["-an"];
    default: {
      const _exhaustive: never = job.audio;

      return _exhaustive;
    }
  }
}

function ffmpegArgs(job: TranscodeJob): string[] {
  const head = ["-hide_banner", "-loglevel", "error", "-y", "-i", job.srcPath];
  const tail = ["-map_metadata", "0", "-movflags", "+faststart", "-f", "mp4", job.outPath];

  switch (job.kind) {
    case "video":
      return [...head, "-map", "0:v:0", ...videoArgs(job), ...audioArgs(job), ...tail];
    case "animation":
      return [
        ...head,
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        String(CRF.avc.high),
        "-vf",
        EVEN_SIZE_FILTER,
        "-pix_fmt",
        "yuv420p",
        "-an",
        ...tail,
      ];
    default: {
      const _exhaustive: never = job;

      return _exhaustive;
    }
  }
}

/** Whether this ffmpeg was built with SVT-AV1; false when it cannot be asked. */
export async function hasSvtAv1(ffmpegPath: string | null): Promise<boolean> {
  if (ffmpegPath === null) {
    return false;
  }

  const result = await runTool({
    executable: ffmpegPath,
    args: ["-hide_banner", "-encoders"],
    timeoutMs: 15_000,
  }).catch(() => null);

  return result?.code === 0 && /\blibsvtav1\b/.test(result.stdout.toString("utf8"));
}

/** Runs one transcode job with ffmpeg, writing the same MP4 the Mediabunny path would. */
export async function transcodeWithFfmpeg(
  ffmpegPath: string,
  job: TranscodeJob,
  signal: AbortSignal,
): Promise<void> {
  const result = await runTool({
    executable: ffmpegPath,
    args: ffmpegArgs(job),
    timeoutMs: TRANSCODE_TIMEOUT_MS,
    signal,
  });

  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim().split("\n").at(-1) || "ffmpeg could not convert the file.",
    );
  }
}

/**
 * Mediabunny runs on the machine's WebCodecs encoders, which are fast but cannot read every file:
 * MPEG-4 Part 2, some odd sizes and other old or unusual formats fail there. When it fails, the
 * job runs again through ffmpeg, and the outcome says so for the journal.
 */
export function withFfmpegFallback(primary: Transcoder, ffmpegPath: string | null): Transcoder {
  return {
    async transcode(job, signal, onProgress): Promise<TranscodeOutcome> {
      try {
        return await primary.transcode(job, signal, onProgress);
      } catch (error) {
        const cause = toError(error);

        if (signal.aborted || isAbortError(cause) || ffmpegPath === null) {
          throw cause;
        }

        try {
          await transcodeWithFfmpeg(ffmpegPath, job, signal);
        } catch (fallbackError) {
          throw new Error(`${cause.message} ffmpeg also failed: ${toError(fallbackError).message}`);
        }

        return { via: "ffmpeg", note: `Converted with ffmpeg (${cause.message})` };
      }
    },
  };
}
