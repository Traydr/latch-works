import path from "node:path";

import type Sharp from "sharp";

/** The sharp library itself, as `require("sharp")` returns it. */
export type SharpLibrary = typeof Sharp;

/**
 * A file path as sharp should get it. libvips opens no Windows path past 260 characters, even with
 * long paths enabled, unless it carries the `\\?\` prefix, which this adds there; elsewhere the
 * path is unchanged.
 */
export function sharpPath(filePath: string): string {
  return path.toNamespacedPath(filePath);
}

/**
 * The native media tools the engine runs. The desktop app resolves them from its packaged
 * resources and tests from `node_modules` and `PATH`, so they are handed in rather than imported.
 */
export interface MediaToolkit {
  sharp: SharpLibrary;
  /** Absolute path to ffmpeg, or null when it is unavailable. */
  ffmpegPath: string | null;
  /** Absolute path to ffprobe, or null when it is unavailable. */
  ffprobePath: string | null;
}
