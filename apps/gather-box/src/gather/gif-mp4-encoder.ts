import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from "mediabunny";
import { throwIfAborted } from "./errors";

const DEFAULT_FRAME_DURATION_MICROSECONDS = 100_000;
const MINIMUM_FRAME_DURATION_MICROSECONDS = 10_000;
const MP4_VIDEO_QUALITY = new Quality("high");

export async function encodeGifAsMp4(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  if (!(await ImageDecoder.isTypeSupported("image/gif"))) {
    throw new Error("This Chrome version cannot decode GIF files.");
  }

  const decoder = new ImageDecoder({
    data: await blob.arrayBuffer(),
    type: "image/gif",
    preferAnimation: true
  });
  let output: Output<Mp4OutputFormat, BufferTarget> | null = null;
  let pendingFirstFrame: ImageDecodeResult | null = null;

  try {
    await decoder.tracks.ready;
    throwIfAborted(signal);
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount < 1) {
      throw new Error("The GIF does not contain any decodable frames.");
    }

    pendingFirstFrame = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
    const width = makeEven(pendingFirstFrame.image.displayWidth);
    const height = makeEven(pendingFirstFrame.image.displayHeight);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Could not create a GIF conversion canvas.");
    }

    const target = new BufferTarget();
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target
    });
    const source = new CanvasSource(canvas, {
      codec: "avc",
      quality: MP4_VIDEO_QUALITY,
      alpha: "discard",
      keyFrameInterval: 2
    });
    output.addVideoTrack(source);
    await output.start();

    let timestampMicroseconds = 0;
    for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex += 1) {
      throwIfAborted(signal);
      const decoded =
        frameIndex === 0
          ? pendingFirstFrame
          : await decoder.decode({ frameIndex, completeFramesOnly: true });
      if (!decoded) {
        throw new Error("The first GIF frame is unavailable.");
      }
      try {
        const durationMicroseconds = Math.max(
          MINIMUM_FRAME_DURATION_MICROSECONDS,
          decoded.image.duration ?? DEFAULT_FRAME_DURATION_MICROSECONDS
        );

        context.fillStyle = "#000";
        context.fillRect(0, 0, width, height);
        context.drawImage(decoded.image, 0, 0);
        await source.add(
          timestampMicroseconds / 1_000_000,
          durationMicroseconds / 1_000_000,
          { keyFrame: frameIndex === 0 }
        );
        timestampMicroseconds += durationMicroseconds;
      } finally {
        decoded.image.close();
        if (frameIndex === 0) {
          pendingFirstFrame = null;
        }
      }
    }

    await output.finalize();
    output = null;
    if (!target.buffer) {
      throw new Error("The MP4 encoder did not produce a video.");
    }
    return target.buffer;
  } catch (error) {
    if (output && output.state !== "canceled" && output.state !== "finalized") {
      await output.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    pendingFirstFrame?.image.close();
    decoder.close();
  }
}

function makeEven(value: number): number {
  return Math.ceil(value / 2) * 2;
}
