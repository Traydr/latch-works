import createAvifEncoder, {
  type AVIFModule,
  type EncodeOptions as AvifEncodeOptions
} from "@jsquash/avif/codec/enc/avif_enc.js";
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from "mediabunny";
import { throwIfAborted } from "./errors";

export const ARCHIVE_AVIF_QUALITY = 70;
export const ARCHIVE_AVIF_SPEED = 6;

const STILL_IMAGE_EXTENSIONS = new Set(["bmp", "jpeg", "jpg", "png", "webp"]);
const DEFAULT_GIF_FRAME_DURATION_MICROSECONDS = 100_000;
const MINIMUM_GIF_FRAME_DURATION_MICROSECONDS = 10_000;
const MP4_VIDEO_QUALITY = new Quality("high");

const AVIF_OPTIONS: AvifEncodeOptions = {
  quality: ARCHIVE_AVIF_QUALITY,
  qualityAlpha: -1,
  denoiseLevel: 0,
  tileRowsLog2: 0,
  tileColsLog2: 0,
  speed: ARCHIVE_AVIF_SPEED,
  subsample: 1,
  chromaDeltaQ: false,
  sharpness: 0,
  enableSharpYUV: false,
  tune: 0,
  bitDepth: 8
};

export type MediaConversionKind = "avif" | "gif-to-mp4" | "rename-avif" | "rename-mp4";

export interface MediaConversionPlan {
  kind: MediaConversionKind;
  fileName: string;
}

export interface ConvertedMedia {
  blob: Blob;
  fileName: string;
  converted: boolean;
}

export interface MediaConverters {
  encodeStillAsAvif(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer>;
  encodeGifAsMp4(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer>;
}

let avifEncoderPromise: Promise<AVIFModule> | null = null;

export function getMediaConversionPlan(
  fileName: string,
  mimeType: string
): MediaConversionPlan | null {
  const extension = getFileExtension(fileName);
  const normalizedMimeType = mimeType.toLowerCase().split(";", 1)[0].trim();

  if (normalizedMimeType === "image/avif") {
    return extension === "avif"
      ? null
      : { kind: "rename-avif", fileName: replaceFileExtension(fileName, "avif") };
  }
  if (normalizedMimeType === "video/mp4") {
    return extension === "mp4"
      ? null
      : { kind: "rename-mp4", fileName: replaceFileExtension(fileName, "mp4") };
  }
  if (extension === "avif" || extension === "mp4" || normalizedMimeType.startsWith("video/")) {
    return null;
  }
  if (extension === "gif" || normalizedMimeType === "image/gif") {
    return { kind: "gif-to-mp4", fileName: replaceFileExtension(fileName, "mp4") };
  }
  if (
    STILL_IMAGE_EXTENSIONS.has(extension) ||
    (normalizedMimeType.startsWith("image/") && normalizedMimeType !== "image/svg+xml")
  ) {
    return { kind: "avif", fileName: replaceFileExtension(fileName, "avif") };
  }

  return null;
}

export async function convertMediaForArchive(
  blob: Blob,
  fileName: string,
  signal?: AbortSignal,
  converters: MediaConverters = DEFAULT_MEDIA_CONVERTERS
): Promise<ConvertedMedia> {
  throwIfAborted(signal);
  const plan = getMediaConversionPlan(fileName, blob.type);
  if (!plan) {
    return { blob, fileName, converted: false };
  }
  if (plan.kind === "rename-avif" || plan.kind === "rename-mp4") {
    return { blob, fileName: plan.fileName, converted: false };
  }

  const buffer =
    plan.kind === "gif-to-mp4"
      ? await converters.encodeGifAsMp4(blob, signal)
      : await converters.encodeStillAsAvif(blob, signal);
  throwIfAborted(signal);

  return {
    blob: new Blob([buffer], { type: plan.kind === "gif-to-mp4" ? "video/mp4" : "image/avif" }),
    fileName: plan.fileName,
    converted: true
  };
}

const DEFAULT_MEDIA_CONVERTERS: MediaConverters = {
  encodeStillAsAvif: async (blob, signal) => encodeAvif(await decodeStillImage(blob, signal)),
  encodeGifAsMp4
};

async function encodeAvif(imageData: ImageData): Promise<ArrayBuffer> {
  const encoder = await getAvifEncoder();
  const encoded = encoder.encode(
    new Uint8Array(imageData.data.buffer),
    imageData.width,
    imageData.height,
    AVIF_OPTIONS
  );
  if (!encoded) {
    throw new Error("The AVIF encoder did not produce an image.");
  }
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer;
}

function getAvifEncoder(): Promise<AVIFModule> {
  if (avifEncoderPromise) {
    return avifEncoderPromise;
  }
  const created = createAvifEncoder({
    locateFile: (path: string) => chrome.runtime.getURL(`codecs/${path}`),
    noInitialRun: true
  });
  avifEncoderPromise = created;
  return created;
}

async function decodeStillImage(blob: Blob, signal?: AbortSignal): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    throwIfAborted(signal);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Could not create an image conversion canvas.");
    }
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function encodeGifAsMp4(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
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
      const durationMicroseconds = Math.max(
        MINIMUM_GIF_FRAME_DURATION_MICROSECONDS,
        decoded.image.duration ?? DEFAULT_GIF_FRAME_DURATION_MICROSECONDS
      );

      context.fillStyle = "#000";
      context.fillRect(0, 0, width, height);
      context.drawImage(decoded.image, 0, 0);
      decoded.image.close();
      if (frameIndex === 0) {
        pendingFirstFrame = null;
      }
      await source.add(
        timestampMicroseconds / 1_000_000,
        durationMicroseconds / 1_000_000,
        { keyFrame: frameIndex === 0 }
      );
      timestampMicroseconds += durationMicroseconds;
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

function getFileExtension(fileName: string): string {
  const lastSegment = fileName.split(/[\\/]/).at(-1) ?? fileName;
  const dotIndex = lastSegment.lastIndexOf(".");
  return dotIndex > 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : "";
}

function replaceFileExtension(fileName: string, extension: string): string {
  const lastSlashIndex = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > lastSlashIndex + 1 ? fileName.slice(0, dotIndex) : fileName;
  return `${baseName}.${extension}`;
}

function makeEven(value: number): number {
  return Math.ceil(value / 2) * 2;
}
