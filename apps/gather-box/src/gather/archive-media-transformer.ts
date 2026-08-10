import { getExpectedArchiveTarget, planArchiveMedia } from "./archive-media-policy";
import { throwIfAborted } from "./errors";
import type { MediaTransformer, TransformedMedia } from "./media-transformer";

export interface ArchiveMediaEncoders {
  encodeStillAsAvif(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer>;
  encodeGifAsMp4(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer>;
}

const DEFAULT_ARCHIVE_MEDIA_ENCODERS: ArchiveMediaEncoders = {
  encodeStillAsAvif: (blob, signal) =>
    import("./avif-encoder").then(({ encodeStillAsAvif }) => encodeStillAsAvif(blob, signal)),
  encodeGifAsMp4: (blob, signal) =>
    import("./gif-mp4-encoder").then(({ encodeGifAsMp4 }) => encodeGifAsMp4(blob, signal))
};

export function createArchiveMediaTransformer(
  encoders: ArchiveMediaEncoders = DEFAULT_ARCHIVE_MEDIA_ENCODERS
): MediaTransformer {
  let conversionQueue = Promise.resolve();

  const enqueueConversion = (task: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> => {
    const result = conversionQueue.then(task);
    conversionQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    expectedTarget: getExpectedArchiveTarget,
    transform: (blob, fileName, signal) =>
      transformArchiveMedia(blob, fileName, encoders, enqueueConversion, signal)
  };
}

export const ARCHIVE_MEDIA_TRANSFORMER = createArchiveMediaTransformer();

async function transformArchiveMedia(
  blob: Blob,
  fileName: string,
  encoders: ArchiveMediaEncoders,
  enqueueConversion: (task: () => Promise<ArrayBuffer>) => Promise<ArrayBuffer>,
  signal?: AbortSignal
): Promise<TransformedMedia> {
  throwIfAborted(signal);
  const plan = planArchiveMedia(fileName, blob.type);
  if (!plan) {
    return { blob, fileName, converted: false };
  }
  if (plan.action === "rename-avif" || plan.action === "rename-mp4") {
    return { blob, fileName: plan.fileName, converted: false };
  }

  const buffer = await enqueueConversion(() =>
    plan.action === "convert-mp4"
      ? encoders.encodeGifAsMp4(blob, signal)
      : encoders.encodeStillAsAvif(blob, signal)
  );
  throwIfAborted(signal);

  return {
    blob: new Blob([buffer], {
      type: plan.action === "convert-mp4" ? "video/mp4" : "image/avif"
    }),
    fileName: plan.fileName,
    converted: true
  };
}
