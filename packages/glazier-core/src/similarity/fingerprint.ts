import type { SharpOptions } from "sharp";

import { runTool } from "../media/run-tool.js";
import type { SharpLibrary } from "../media/toolkit.js";
import { formatHash, type Hash64, PHASH_INPUT_SIZE, parseHash, perceptualHash } from "./phash.js";

/** A video is sampled at these points of its duration; an animation at the same share of its frames' time. */
const SAMPLE_POSITIONS = [0.1, 0.3, 0.5, 0.7, 0.9] as const;

const FRAME_TIMEOUT_MS = 60_000;

/** A still's fingerprint, or five frames' for anything that moves. */
export type Fingerprint =
  | { kind: "still"; hash: Hash64 }
  | { kind: "motion"; durationMs: number; frames: Hash64[] };

/** Stored as `s:<hash>` or `m:<durationMs>:<hash>.<hash>…`. */
export function formatFingerprint(fingerprint: Fingerprint): string {
  switch (fingerprint.kind) {
    case "still":
      return `s:${formatHash(fingerprint.hash)}`;
    case "motion":
      return `m:${Math.round(fingerprint.durationMs)}:${fingerprint.frames.map(formatHash).join(".")}`;
    default: {
      const _exhaustive: never = fingerprint;

      return _exhaustive;
    }
  }
}

export function parseFingerprint(stored: string): Fingerprint {
  if (stored.startsWith("s:")) {
    return { kind: "still", hash: parseHash(stored.slice(2)) };
  }

  const [prefix, duration, frames] = stored.split(":");

  if (prefix !== "m" || duration === undefined || frames === undefined) {
    throw new Error(`Not a fingerprint: ${stored}`);
  }

  return { kind: "motion", durationMs: Number(duration), frames: frames.split(".").map(parseHash) };
}

/**
 * A picture as `size`×`size` grey, the way every print reads it: EXIF orientation applied and
 * transparency laid on white, so a PNG with alpha and the JPEG made from it agree.
 */
export function greyPixels(
  sharp: SharpLibrary,
  filePath: string,
  request: { size: number; page?: number },
): Promise<Buffer> {
  const options: SharpOptions = { failOn: "none", limitInputPixels: false };

  if (request.page !== undefined) {
    options.page = request.page;
  }

  return sharp(filePath, options)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(request.size, request.size, { fit: "fill", kernel: "lanczos3" })
    .greyscale()
    .raw()
    .toBuffer();
}

export async function fingerprintStill(
  sharp: SharpLibrary,
  filePath: string,
): Promise<Fingerprint> {
  return {
    kind: "still",
    hash: perceptualHash(await greyPixels(sharp, filePath, { size: PHASH_INPUT_SIZE })),
  };
}

/**
 * The display time of each frame. Browsers show a frame with no delay (or under 10 ms) for
 * 100 ms, and so does the MP4 Gather Box makes from it, so the durations agree.
 */
export function animationFrameTimes(delaysMs: readonly number[], frameCount: number): number[] {
  const times: number[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    const delay = delaysMs[index] ?? 0;
    times.push(delay <= 10 ? 100 : delay);
  }

  return times;
}

/** Fingerprints an animated GIF, WebP or PNG from the frames on screen at the sample positions. */
export async function fingerprintAnimation(
  sharp: SharpLibrary,
  filePath: string,
  frameTimesMs: readonly number[],
): Promise<Fingerprint> {
  const durationMs = frameTimesMs.reduce((sum, time) => sum + time, 0);
  const frames: Hash64[] = [];

  for (const position of SAMPLE_POSITIONS) {
    const target = durationMs * position;
    let elapsed = 0;
    let page = 0;

    while (page < frameTimesMs.length - 1 && elapsed + (frameTimesMs[page] ?? 0) <= target) {
      elapsed += frameTimesMs[page] ?? 0;
      page += 1;
    }

    frames.push(
      perceptualHash(await greyPixels(sharp, filePath, { size: PHASH_INPUT_SIZE, page })),
    );
  }

  return { kind: "motion", durationMs, frames };
}

/** Fingerprints a video from single frames ffmpeg decodes at the sample positions. */
export async function fingerprintVideo(
  ffmpegPath: string,
  filePath: string,
  durationMs: number,
  signal?: AbortSignal,
): Promise<Fingerprint> {
  const frames: Hash64[] = [];
  const expectedBytes = PHASH_INPUT_SIZE * PHASH_INPUT_SIZE;

  for (const position of SAMPLE_POSITIONS) {
    const seconds = (durationMs * position) / 1000;

    const result = await runTool({
      executable: ffmpegPath,
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        seconds.toFixed(3),
        "-i",
        filePath,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-vf",
        `scale=${PHASH_INPUT_SIZE}:${PHASH_INPUT_SIZE}:flags=area,format=gray`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
      ],
      timeoutMs: FRAME_TIMEOUT_MS,
      signal,
    });

    if (result.code !== 0 || result.stdout.length < expectedBytes) {
      throw new Error(result.stderr.trim().split("\n").at(-1) || "ffmpeg returned no frame.");
    }

    frames.push(perceptualHash(new Uint8Array(result.stdout.subarray(0, expectedBytes))));
  }

  return { kind: "motion", durationMs, frames };
}
