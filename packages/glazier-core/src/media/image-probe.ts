import type { SharpLibrary } from "./toolkit.js";

export interface ImageProbe {
  /** Display dimensions, after EXIF orientation. */
  width: number;
  height: number;
  /** 1 for a still; the frame count of an animated GIF, WebP or PNG. */
  frames: number;
  hasAlpha: boolean;
  /** Per-frame display times in milliseconds for an animation, as the file states them. */
  frameDelaysMs: number[];
}

/** EXIF orientations 5–8 rotate by 90°, so the stored width is the displayed height. */
function isQuarterTurn(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

/** Reads an image's header through sharp (libvips) without decoding its pixels. */
export async function probeImage(sharp: SharpLibrary, filePath: string): Promise<ImageProbe> {
  const metadata = await sharp(filePath, { failOn: "none", limitInputPixels: false }).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("The image has no dimensions.");
  }

  const quarterTurn = isQuarterTurn(metadata.orientation);
  const frames = Math.max(1, metadata.pages ?? 1);
  const pageHeight = metadata.pageHeight ?? metadata.height;

  return {
    width: quarterTurn ? pageHeight : metadata.width,
    height: quarterTurn ? metadata.width : pageHeight,
    frames,
    hasAlpha: metadata.hasAlpha ?? false,
    frameDelaysMs: frames > 1 ? (metadata.delay ?? []) : [],
  };
}
