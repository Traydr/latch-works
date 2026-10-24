import type Sharp from "sharp";

/** The sharp library itself, as `require("sharp")` returns it. */
export type SharpLibrary = typeof Sharp;

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
