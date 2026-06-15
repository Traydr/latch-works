import type { ThumbnailSize } from "@latch-works/media-delivery";
import type { MediaType } from "@latch-works/media-domain";
import type { S3StorageClient } from "@latch-works/media-storage";

/**
 * Minimal description of a source media object required to generate a
 * derivative. Both Pane View (inline mode) and the media-optimizer service
 * build this from their own data sources.
 */
export interface DerivativeSource {
  extension: string;
  mediaType: MediaType;
  /** Pre-resolved original key; falls back to the sha256-derived key when absent. */
  originalObjectKey?: string;
  sha256: string;
}

export interface GeneratedDerivative {
  bytes: Buffer;
  height: number;
  width: number;
}

export type FfmpegRunner = (binaryPath: string, args: string[]) => Promise<void>;

export interface GenerateDerivativeOptions {
  /** Overrides the bundled ffmpeg-static binary path (mainly for tests). */
  ffmpegPath?: string | null;
  /** Overrides the ffmpeg process runner (mainly for tests). */
  ffmpegRunner?: FfmpegRunner;
  maxSourceBytes?: number;
  size: ThumbnailSize;
  source: DerivativeSource;
  storage: S3StorageClient;
}
