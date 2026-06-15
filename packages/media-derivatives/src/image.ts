import type { ThumbnailSize } from "@latch-works/media-delivery";
import sharp from "sharp";
import type { GeneratedDerivative } from "./types.js";

export async function resizeImageToWebp(
  input: Buffer,
  size: ThumbnailSize,
): Promise<GeneratedDerivative> {
  const result = await sharp(input)
    .rotate()
    .resize(size, size, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 90 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: result.data,
    height: result.info.height,
    width: result.info.width,
  };
}

export async function readWebpMetadata(bytes: Buffer): Promise<{ height: number; width: number }> {
  const metadata = await sharp(bytes).metadata();
  return {
    height: metadata.height ?? 0,
    width: metadata.width ?? 0,
  };
}
