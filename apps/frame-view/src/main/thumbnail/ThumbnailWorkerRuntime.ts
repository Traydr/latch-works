import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type {
  ThumbnailDebugOptions,
  ThumbnailJobRequest,
  ThumbnailWorkerCapabilities,
  ThumbnailWorkerJobResult,
  ThumbnailWorkerRequest,
  ThumbnailWorkerResponse,
} from '../../shared/thumbnail';
import { RequestAbortError, toError } from '../errors';
import { resolveBinaryPath } from '../services/mediaBinaryResolver';
import { MediaToolsAbortError, MediaToolsService } from '../services/mediaToolsService';

type SharpLib = typeof import('sharp');

const VIDEO_WEBP_QUALITY = 82;
const VIDEO_WEBP_EFFORT = 4;
const IMAGE_WEBP_QUALITY = 92;
const IMAGE_WEBP_EFFORT = 5;
const SHARP_CACHE_MEMORY_MB = 32;
const SHARP_CACHE_ITEMS = 64;
const nativeRequire = createRequire(__filename);
const LOSSLESS_IMAGE_EXTENSIONS = new Set(['.png', '.bmp', '.gif']);

/**
 * `sharp` is a CommonJS module: `require` yields the callable library itself, or an ES-interop
 * wrapper whose `default` is that library.
 */
function resolveSharpModule(sharpModule: SharpLib & { default?: SharpLib }): SharpLib {
  return sharpModule.default ?? sharpModule;
}

function loadPackagedSharp(): SharpLib | null {
  if (!process.resourcesPath) {
    return null;
  }

  try {
    const packagedRequire = createRequire(
      path.join(process.resourcesPath, 'node_modules', 'sharp', 'package.json'),
    );
    return resolveSharpModule(packagedRequire('sharp'));
  } catch {
    return null;
  }
}

interface ActiveJob {
  abortController: AbortController;
  kind: 'image' | 'video';
}

interface ThumbnailWorkerRuntimeOptions {
  cacheRootPath?: string;
  mediaToolsService?: MediaToolsService;
  userDataPath: string;
  workerPath?: string | null;
}

export class ThumbnailWorkerRuntime {
  private readonly diskCacheDir: string;
  private readonly mediaToolsService: MediaToolsService;
  private readonly activeJobs = new Map<number, ActiveJob>();

  private debugOptions: ThumbnailDebugOptions = {
    enableDebugLogging: false,
    enablePerformanceMonitoring: false,
  };
  private lastSharpLoadError: string | null = null;
  private sharp: SharpLib | null = null;
  private sharpLoadFailureLogged = false;

  constructor(private readonly options: ThumbnailWorkerRuntimeOptions) {
    this.diskCacheDir = path.join(
      options.cacheRootPath ?? options.userDataPath,
      'frame-view',
      'thumbnails',
    );
    this.mediaToolsService = options.mediaToolsService ?? new MediaToolsService();
  }

  async init(): Promise<ThumbnailWorkerCapabilities> {
    await fs.mkdir(this.diskCacheDir, { recursive: true });
    this.sharp = this.loadSharp();

    if (this.sharp) {
      this.sharp.concurrency(1);
      this.sharp.cache({
        memory: SHARP_CACHE_MEMORY_MB,
        files: 0,
        items: SHARP_CACHE_ITEMS,
      });
    }

    const mediaToolsStatus = this.mediaToolsService.getStatus();
    const ffmpegResolution = resolveBinaryPath(mediaToolsStatus.ffmpegPath);
    const ffprobeResolution = resolveBinaryPath(mediaToolsStatus.ffprobePath);
    const probeErrors = [
      this.lastSharpLoadError,
      ffmpegResolution.error,
      ffprobeResolution.error,
    ].filter((error): error is string => !!error);

    return {
      ffmpegAvailable: mediaToolsStatus.ffmpegAvailable && ffmpegResolution.exists,
      ffmpegExists: ffmpegResolution.exists,
      ffmpegPath: ffmpegResolution.resolvedPath,
      ffprobeAvailable: mediaToolsStatus.ffprobeAvailable && ffprobeResolution.exists,
      ffprobeExists: ffprobeResolution.exists,
      ffprobePath: ffprobeResolution.resolvedPath,
      probeErrors,
      sharpAvailable: this.sharp !== null,
      workerPath: this.options.workerPath ?? null,
    };
  }

  setDebugOptions(options: ThumbnailDebugOptions): void {
    this.debugOptions = options;
  }

  async getCapabilities(): Promise<ThumbnailWorkerCapabilities> {
    return this.init();
  }

  getDebugOptions(): ThumbnailDebugOptions {
    return this.debugOptions;
  }

  private logDebug(message: string): void {
    if (!this.debugOptions.enableDebugLogging) {
      return;
    }

    console.info(`[thumbnailWorker] ${message}`);
  }

  private toErrorResponse(requestId: number, error: Error): ThumbnailWorkerResponse {
    if (error instanceof RequestAbortError || error.name === 'AbortError') {
      return {
        requestId,
        ok: false,
        error: 'Thumbnail request aborted',
        errorCode: 'abort',
      };
    }

    if (error.message.startsWith('Sharp decode failed:')) {
      return {
        requestId,
        ok: false,
        error: error.message,
        errorCode: 'sharp-decode',
      };
    }

    if (error.message.startsWith('Video frame extraction failed:')) {
      return {
        requestId,
        ok: false,
        error: error.message,
        errorCode: 'video-extraction',
      };
    }

    if (error.message === 'Sharp is unavailable') {
      return {
        requestId,
        ok: false,
        error: error.message,
        errorCode: 'worker-init',
      };
    }

    return {
      requestId,
      ok: false,
      error: error.message,
      errorCode: 'unknown',
    };
  }

  async handleRequest(request: ThumbnailWorkerRequest): Promise<ThumbnailWorkerResponse | null> {
    if (request.type === 'cancel-thumbnail') {
      this.activeJobs.get(request.requestId)?.abortController.abort();
      return null;
    }

    if (request.type === 'set-debug-options') {
      this.setDebugOptions(request.options);
      return null;
    }

    if (request.type === 'get-capabilities') {
      return {
        requestId: request.requestId,
        ok: true,
        result: await this.getCapabilities(),
      };
    }

    const abortController = new AbortController();
    this.activeJobs.set(request.requestId, {
      abortController,
      kind: request.job.kind,
    });

    try {
      const result = await this.generateThumbnail(request.job, abortController.signal);
      return {
        requestId: request.requestId,
        ok: true,
        result,
      };
    } catch (cause) {
      return this.toErrorResponse(request.requestId, toError(cause));
    } finally {
      this.activeJobs.delete(request.requestId);
    }
  }

  private async generateThumbnail(
    job: ThumbnailJobRequest,
    signal: AbortSignal,
  ): Promise<ThumbnailWorkerJobResult> {
    const sharp = this.sharp ?? this.loadSharp();
    if (!sharp) {
      throw new Error('Sharp is unavailable');
    }

    let bytes: Uint8Array;

    if (job.kind === 'video') {
      let frameBuffer: Buffer | null = null;
      try {
        frameBuffer = await this.mediaToolsService.extractVideoFrame(
          job.mediaPath,
          job.thumbSize,
          signal,
        );
      } catch (error) {
        if (
          error instanceof MediaToolsAbortError ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          throw new RequestAbortError();
        }
        throw error;
      }

      if (!frameBuffer || frameBuffer.byteLength === 0) {
        throw new Error(`Video frame extraction failed: ${path.basename(job.mediaPath)}`);
      }

      bytes = new Uint8Array(
        await sharp(frameBuffer)
          .rotate()
          .resize({
            width: job.thumbSize,
            height: job.thumbSize,
            fit: 'inside',
            withoutEnlargement: false,
          })
          .webp({
            quality: VIDEO_WEBP_QUALITY,
            effort: VIDEO_WEBP_EFFORT,
          })
          .toBuffer(),
      );
    } else {
      const sourceExtension = path.extname(job.mediaPath).toLowerCase();
      const imageWebpOptions = LOSSLESS_IMAGE_EXTENSIONS.has(sourceExtension)
        ? {
            effort: IMAGE_WEBP_EFFORT,
            lossless: true as const,
          }
        : {
            effort: IMAGE_WEBP_EFFORT,
            quality: IMAGE_WEBP_QUALITY,
          };

      try {
        bytes = new Uint8Array(
          await sharp(job.mediaPath, {
            animated: false,
            sequentialRead: true,
          })
            .rotate()
            .resize({
              width: job.thumbSize,
              height: job.thumbSize,
              fit: 'inside',
              withoutEnlargement: false,
            })
            .webp(imageWebpOptions)
            .toBuffer(),
        );
      } catch (error) {
        const message = `Sharp decode failed: ${path.basename(job.mediaPath)}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.logDebug(message);
        throw new Error(message);
      }
    }

    if (signal.aborted) {
      throw new RequestAbortError();
    }

    const cacheWrite = await this.writeDiskThumbnail(job.cacheKey, bytes);
    return {
      bytes: new Uint8Array(bytes),
      cacheCreated: cacheWrite.cacheCreated,
      cacheKey: job.cacheKey,
      contentType: 'image/webp',
    };
  }

  private loadSharp(): SharpLib | null {
    try {
      const sharpLib = resolveSharpModule(nativeRequire('sharp'));
      this.lastSharpLoadError = null;
      return sharpLib;
    } catch (cause) {
      const packagedSharp = loadPackagedSharp();
      if (packagedSharp) {
        this.lastSharpLoadError = null;
        return packagedSharp;
      }

      this.lastSharpLoadError = toError(cause).message;
      if (!this.sharpLoadFailureLogged) {
        this.sharpLoadFailureLogged = true;
        console.warn(`[thumbnailWorker] sharp failed to load: ${this.lastSharpLoadError}`);
      }
      return null;
    }
  }

  private async writeDiskThumbnail(
    cacheKey: string,
    bytes: Uint8Array,
  ): Promise<{ cacheCreated: boolean }> {
    const diskPath = path.join(this.diskCacheDir, `${cacheKey}.webp`);
    let cacheCreated = false;

    try {
      await fs.stat(diskPath);
    } catch {
      cacheCreated = true;
    }

    await fs.writeFile(diskPath, bytes);
    return { cacheCreated };
  }
}
