import type { TranscodeJob } from "@latch-works/glazier-core/contract";
import { encodeAnimationAsMp4 } from "@latch-works/media-format/animation-mp4";
import {
  ALL_FORMATS,
  Conversion,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
  CustomSource,
  canEncodeAudio,
  getEncodableVideoCodecs,
  Input,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  type Quality,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";

import type { TranscoderBridge } from "../shared/bridge";
import type { TranscoderJobMessage } from "../shared/messages";

declare global {
  interface Window {
    glazierTranscoder?: TranscoderBridge;
  }
}

const bridgeOrNull = window.glazierTranscoder;

if (!bridgeOrNull) {
  throw new Error("The transcoder bridge is unavailable.");
}

const bridge = bridgeOrNull;

const QUALITIES = {
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  "very-high": QUALITY_VERY_HIGH,
} as const satisfies Record<Extract<TranscodeJob, { kind: "video" }>["quality"], Quality>;

/** Conversions the user can cancel, by job id. */
const cancellers = new Map<number, () => Promise<void>>();

const queue: TranscoderJobMessage[] = [];

let busy = false;

/**
 * H.264 and HEVC encoders take only even frame sizes. An odd-sized source loses its last pixel
 * row or column to a crop; Mediabunny's resize path sizes odd frames wrongly, and a crop keeps
 * every other pixel untouched.
 */
function evenCrop(track: InputVideoTrack): ConversionVideoOptions["crop"] {
  const width = Math.floor(track.displayWidth / 2) * 2;
  const height = Math.floor(track.displayHeight / 2) * 2;

  return width === track.displayWidth && height === track.displayHeight
    ? undefined
    : { left: 0, top: 0, width, height };
}

function videoOptions(
  job: Extract<TranscodeJob, { kind: "video" }>,
  track: InputVideoTrack,
): ConversionVideoOptions {
  switch (job.video.action) {
    case "copy":
      return {};
    case "encode":
      return {
        codec: job.video.codec,
        quality: QUALITIES[job.quality],
        forceTranscode: true,
        crop: evenCrop(track),
      };
    default: {
      const _exhaustive: never = job.video;

      return _exhaustive;
    }
  }
}

function audioOptions(job: Extract<TranscodeJob, { kind: "video" }>): ConversionAudioOptions {
  switch (job.audio.action) {
    case "copy":
      return {};
    case "encode-aac":
      return { codec: "aac", quality: QUALITY_HIGH };
    case "drop":
      return { discard: true };
    default: {
      const _exhaustive: never = job.audio;

      return _exhaustive;
    }
  }
}

/**
 * Rewrites a video into MP4. Tracks Mediabunny can copy are copied untouched; the rest are
 * encoded as planned. A track that would be lost (an unsupported subtitle or codec) fails the
 * job instead of silently disappearing.
 */
async function convertVideo(
  id: number,
  job: Extract<TranscodeJob, { kind: "video" }>,
): Promise<void> {
  const source = await bridge.openRead(job.srcPath);
  const target = await bridge.openWrite(job.outPath);

  const input = new Input({
    formats: ALL_FORMATS,
    source: new CustomSource({
      getSize: () => source.size,
      read: (start, end) => bridge.read(source.handle, start, end),
      prefetchProfile: "fileSystem",
    }),
  });

  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => bridge.write(target, chunk.position, chunk.data),
  });

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, { chunked: true }),
  });

  try {
    const conversion = await Conversion.init({
      input,
      output,
      video: (track) => videoOptions(job, track),
      audio: audioOptions(job),
    });

    const lost = conversion.discardedTracks.filter((track) => track.reason !== "discarded_by_user");

    if (lost.length > 0 || !conversion.isValid) {
      const reasons = lost.map((track) => `${track.track.type} track (${track.reason})`);

      throw new Error(
        `This file cannot move into MP4 without losing: ${reasons.join(", ") || "its tracks"}.`,
      );
    }

    cancellers.set(id, () => conversion.cancel());
    conversion.onProgress = (progress) => bridge.send({ type: "progress", id, ratio: progress });
    await conversion.execute();
  } finally {
    cancellers.delete(id);
    input.dispose();
    await bridge.close(source.handle);
    await bridge.close(target);
  }
}

async function convertAnimation(
  id: number,
  job: Extract<TranscodeJob, { kind: "animation" }>,
): Promise<void> {
  const controller = new AbortController();
  cancellers.set(id, async () => controller.abort());

  try {
    const bytes = await bridge.readFile(job.srcPath);

    const encoded = await encodeAnimationAsMp4(
      new Blob([bytes], { type: job.mimeType }),
      job.mimeType,
      controller.signal,
    );

    await bridge.writeFile(job.outPath, new Uint8Array(encoded));
  } finally {
    cancellers.delete(id);
  }
}

async function run(message: TranscoderJobMessage): Promise<void> {
  try {
    switch (message.job.kind) {
      case "video":
        await convertVideo(message.id, message.job);
        break;
      case "animation":
        await convertAnimation(message.id, message.job);
        break;
      default: {
        const _exhaustive: never = message.job;

        return _exhaustive;
      }
    }

    bridge.send({ type: "done", id: message.id });
  } catch (error) {
    bridge.send({
      type: "failed",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function drain(): Promise<void> {
  if (busy) {
    return;
  }

  busy = true;

  for (let next = queue.shift(); next; next = queue.shift()) {
    await run(next);
  }

  busy = false;
}

bridge.onJob((message) => {
  queue.push(message);
  void drain();
});

bridge.onCancel((id) => {
  void cancellers.get(id)?.();
});

/** What this machine's WebCodecs can encode, reported once so the UI offers only those. */
async function reportCapabilities(): Promise<void> {
  const codecs = await getEncodableVideoCodecs(["avc", "hevc", "av1"], {
    width: 1920,
    height: 1080,
  });

  bridge.send({
    type: "capabilities",
    video: {
      avc: codecs.includes("avc"),
      hevc: codecs.includes("hevc"),
      av1: codecs.includes("av1"),
    },
    aac: await canEncodeAudio("aac"),
  });
}

void reportCapabilities();
