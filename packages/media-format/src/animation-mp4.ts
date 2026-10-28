import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from "mediabunny";

const DEFAULT_FRAME_DURATION_MICROSECONDS = 100_000;

const MINIMUM_FRAME_DURATION_MICROSECONDS = 10_000;

/**
 * What an animation becomes: H.264 at Mediabunny's "high" quality, its transparency flattened
 * onto black, a key frame at least every 2 seconds, and the MP4's index written first. Exported
 * for Oriel GPUI's conformance vectors (plan 063), so its port keeps the same settings.
 */
export const ANIMATION_MP4_SETTINGS = {
  codec: "avc",
  quality: "high",
  alpha: "discard",
  keyFrameIntervalSeconds: 2,
  fastStart: "in-memory",
} as const;

const MP4_VIDEO_QUALITY = new Quality(ANIMATION_MP4_SETTINGS.quality);

/**
 * An MP4 muxer already wired to a canvas. Naming this seam keeps the GIF conversion loop free of
 * the muxer library and lets a test drive frame timing without a real video encoder.
 */
export interface Mp4VideoSink {
  addFrame(
    timestampSeconds: number,
    durationSeconds: number,
    options: { keyFrame: boolean },
  ): Promise<void>;
  /** Resolves with the finished MP4, or rejects if the muxer produced nothing. */
  finalize(): Promise<ArrayBuffer>;
  /** Discards a partially written video. Safe to call on an already finished sink. */
  cancel(): Promise<void>;
}

export interface Mp4Encoder {
  open(canvas: OffscreenCanvas): Promise<Mp4VideoSink>;
}

export const mediabunnyMp4Encoder: Mp4Encoder = {
  async open(canvas) {
    const target = new BufferTarget();

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: ANIMATION_MP4_SETTINGS.fastStart }),
      target,
    });

    const source = new CanvasSource(canvas, {
      codec: ANIMATION_MP4_SETTINGS.codec,
      quality: MP4_VIDEO_QUALITY,
      alpha: ANIMATION_MP4_SETTINGS.alpha,
      keyFrameInterval: ANIMATION_MP4_SETTINGS.keyFrameIntervalSeconds,
    });

    output.addVideoTrack(source);
    await output.start();

    return {
      addFrame: (timestampSeconds, durationSeconds, options) =>
        source.add(timestampSeconds, durationSeconds, options),
      async finalize() {
        await output.finalize();

        if (!target.buffer) {
          throw new Error("The MP4 encoder did not produce a video.");
        }

        return target.buffer;
      },
      async cancel() {
        if (output.state !== "canceled" && output.state !== "finalized") {
          await output.cancel().catch(() => undefined);
        }
      },
    };
  },
};

export function encodeGifAsMp4(
  blob: Blob,
  signal?: AbortSignal,
  encoder: Mp4Encoder = mediabunnyMp4Encoder,
): Promise<ArrayBuffer> {
  return encodeAnimationAsMp4(blob, "image/gif", signal, encoder);
}

/**
 * Re-encodes an animated image (GIF, animated WebP, APNG) as an MP4 with one video frame per
 * image frame, keeping each frame's own duration. `mimeType` names the image format for the
 * decoder; Chromium decodes all three.
 */
export async function encodeAnimationAsMp4(
  blob: Blob,
  mimeType: AnimatedImageMimeType,
  signal?: AbortSignal,
  encoder: Mp4Encoder = mediabunnyMp4Encoder,
): Promise<ArrayBuffer> {
  throwIfAborted(signal);

  if (!(await ImageDecoder.isTypeSupported(mimeType))) {
    throw new Error(`This Chromium version cannot decode ${mimeType} files.`);
  }

  const decoder = new ImageDecoder({
    data: await blob.arrayBuffer(),
    type: mimeType,
    preferAnimation: true,
  });

  let sink: Mp4VideoSink | null = null;
  let pendingFirstFrame: ImageDecodeResult | null = null;

  try {
    await decoder.tracks.ready;
    throwIfAborted(signal);
    const track = decoder.tracks.selectedTrack;

    if (!track || track.frameCount < 1) {
      throw new Error("The animation does not contain any decodable frames.");
    }

    pendingFirstFrame = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
    const width = makeEven(pendingFirstFrame.image.displayWidth);
    const height = makeEven(pendingFirstFrame.image.displayHeight);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });

    if (!context) {
      throw new Error("Could not create an animation conversion canvas.");
    }

    sink = await encoder.open(canvas);

    let timestampMicroseconds = 0;

    for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex += 1) {
      throwIfAborted(signal);

      const decoded =
        frameIndex === 0
          ? pendingFirstFrame
          : await decoder.decode({ frameIndex, completeFramesOnly: true });

      if (!decoded) {
        throw new Error("The first animation frame is unavailable.");
      }

      try {
        const durationMicroseconds = Math.max(
          MINIMUM_FRAME_DURATION_MICROSECONDS,
          decoded.image.duration ?? DEFAULT_FRAME_DURATION_MICROSECONDS,
        );

        context.fillStyle = "#000";
        context.fillRect(0, 0, width, height);
        context.drawImage(decoded.image, 0, 0);
        await sink.addFrame(timestampMicroseconds / 1_000_000, durationMicroseconds / 1_000_000, {
          keyFrame: frameIndex === 0,
        });
        timestampMicroseconds += durationMicroseconds;
      } finally {
        decoded.image.close();

        if (frameIndex === 0) {
          pendingFirstFrame = null;
        }
      }
    }

    const finished = await sink.finalize();
    sink = null;

    return finished;
  } catch (error) {
    await sink?.cancel();
    throw error;
  } finally {
    pendingFirstFrame?.image.close();
    decoder.close();
  }
}

function makeEven(value: number): number {
  return Math.ceil(value / 2) * 2;
}

/** The animated image formats Chromium's `ImageDecoder` reads frame by frame. */
export type AnimatedImageMimeType = "image/gif" | "image/webp" | "image/png";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}
