import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { ZodType } from 'zod';
import { z } from 'zod';

import type { VideoProbeMetadata } from '../../shared/types';
import { resolveBinaryPath } from './mediaBinaryResolver';

interface MediaToolsStatus {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface BinaryCommandResult {
  aborted: boolean;
  code: number;
  stderr: string;
  stdout: Buffer;
}

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_PROBE_CACHE_ENTRIES = 2000;
const MAX_FRAME_EXTRACTION_FAILURE_LOGS = 3;
const nativeRequire = createRequire(__filename);

/** `ffmpeg-static` exports the binary path directly or as a CommonJS default export. */
const BinaryPathModuleSchema = z.union([
  z.string(),
  z.object({ default: z.string() }).transform((module) => module.default),
]);

/** `@ffprobe-installer/ffprobe` exports `{ path }`, directly or as a CommonJS default export. */
const FfprobeModuleSchema = z.union([
  z.object({ path: z.string() }).transform((module) => module.path),
  z.object({ default: z.object({ path: z.string() }) }).transform((module) => module.default.path),
]);

function requireFromPackagedNodeModules<T>(packageName: string, schema: ZodType<T>): T | null {
  if (!process.resourcesPath) {
    return null;
  }

  try {
    const packagedRequire = createRequire(
      path.join(process.resourcesPath, 'node_modules', packageName, 'package.json'),
    );
    const parsed = schema.safeParse(packagedRequire(packageName));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class MediaToolsAbortError extends Error {
  constructor() {
    super('Media tools command aborted');
    this.name = 'AbortError';
  }
}

export class MediaToolsService {
  private readonly ffmpegAvailable: boolean;
  private readonly ffmpegPath: string | null;
  private readonly ffprobeAvailable: boolean;
  private readonly ffprobePath: string | null;

  private frameExtractionFailureLogs = 0;

  private readonly probeCache = new Map<string, VideoProbeMetadata>();

  constructor() {
    const ffmpegResolution = resolveBinaryPath(this.loadFfmpegPath());
    const ffprobeResolution = resolveBinaryPath(this.loadFfprobePath());

    this.ffmpegAvailable = ffmpegResolution.exists;
    this.ffprobeAvailable = ffprobeResolution.exists;
    this.ffmpegPath = ffmpegResolution.resolvedPath;
    this.ffprobePath = ffprobeResolution.resolvedPath;
  }

  getStatus(): MediaToolsStatus {
    return {
      ffmpegAvailable: this.ffmpegAvailable,
      ffprobeAvailable: this.ffprobeAvailable,
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
    };
  }

  async probeVideo(
    mediaPath: string,
    mtimeMs: number,
    fileSize: number,
  ): Promise<VideoProbeMetadata | null> {
    if (!this.ffprobeAvailable || !this.ffprobePath) {
      return null;
    }

    const cacheKey = `${mediaPath}|${mtimeMs}|${fileSize}`;
    const cached = this.probeCache.get(cacheKey);
    if (cached) {
      this.probeCache.delete(cacheKey);
      this.probeCache.set(cacheKey, cached);
      return cached;
    }

    const result = await this.runCommand(
      this.ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', mediaPath],
      DEFAULT_TIMEOUT_MS,
    );

    if (result.code !== 0) {
      return null;
    }

    let parsed: {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        duration?: string;
      }>;
      format?: {
        duration?: string;
      };
    };

    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return null;
    }

    const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');

    const streamDuration = Number(videoStream?.duration ?? Number.NaN);
    const formatDuration = Number(parsed.format?.duration ?? Number.NaN);
    const durationSeconds = Number.isFinite(streamDuration)
      ? streamDuration
      : Number.isFinite(formatDuration)
        ? formatDuration
        : Number.NaN;

    const metadata: VideoProbeMetadata = {
      durationMs: Number.isFinite(durationSeconds)
        ? Math.max(0, Math.round(durationSeconds * 1000))
        : undefined,
      width: Number.isFinite(videoStream?.width) ? videoStream?.width : undefined,
      height: Number.isFinite(videoStream?.height) ? videoStream?.height : undefined,
      codec: videoStream?.codec_name,
    };

    if (this.probeCache.size >= MAX_PROBE_CACHE_ENTRIES) {
      const oldestKey = this.probeCache.keys().next().value;
      if (oldestKey) {
        this.probeCache.delete(oldestKey);
      }
    }

    this.probeCache.set(cacheKey, metadata);
    return metadata;
  }

  async extractVideoFrame(
    mediaPath: string,
    sizeHint: number,
    abortSignal?: AbortSignal,
  ): Promise<Buffer | null> {
    if (!this.ffmpegAvailable || !this.ffmpegPath) {
      return null;
    }

    if (abortSignal?.aborted) {
      throw new MediaToolsAbortError();
    }

    void sizeHint;
    let lastFailureReason = '';

    const attemptArgs = [
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        '00:00:01',
        '-i',
        mediaPath,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ],
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        '00:00:00',
        '-i',
        mediaPath,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ],
    ];

    try {
      for (const args of attemptArgs) {
        const result = await this.runBinaryCommand(
          this.ffmpegPath,
          args,
          DEFAULT_TIMEOUT_MS,
          abortSignal,
        );
        if (result.aborted) {
          throw new MediaToolsAbortError();
        }
        if (result.code === 0 && result.stdout.byteLength > 0) {
          return result.stdout;
        }
        if (result.stderr.trim()) {
          lastFailureReason = result.stderr.trim();
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      return null;
    }

    if (lastFailureReason && this.frameExtractionFailureLogs < MAX_FRAME_EXTRACTION_FAILURE_LOGS) {
      this.frameExtractionFailureLogs += 1;
      console.warn(
        `[mediaToolsService] ffmpeg could not extract a frame from ${path.basename(mediaPath)}: ${lastFailureReason}`,
      );
    }

    return null;
  }

  private loadStringModule(moduleName: string): string | null {
    try {
      const parsed = BinaryPathModuleSchema.safeParse(nativeRequire(moduleName));
      return parsed.success ? parsed.data : null;
    } catch {
      return requireFromPackagedNodeModules(moduleName, BinaryPathModuleSchema);
    }
  }

  private loadFfmpegPath(): string | null {
    return this.loadStringModule('ffmpeg-static');
  }

  private loadFfprobePath(): string | null {
    try {
      const parsed = FfprobeModuleSchema.safeParse(nativeRequire('@ffprobe-installer/ffprobe'));
      return parsed.success ? parsed.data : null;
    } catch {
      return requireFromPackagedNodeModules('@ffprobe-installer/ffprobe', FfprobeModuleSchema);
    }
  }

  private runCommand(
    executable: string,
    args: string[],
    timeoutMs: number,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(executable, args, {
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, timeoutMs);

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({
          code: -1,
          stdout,
          stderr: `${stderr}\n${error.message}`.trim(),
        });
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({
          code: code ?? -1,
          stdout,
          stderr,
        });
      });
    });
  }

  private runBinaryCommand(
    executable: string,
    args: string[],
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<BinaryCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      let stderr = '';
      let settled = false;
      let wasAborted = false;

      const cleanupAbortListener = (abortHandler: (() => void) | null): void => {
        if (abortSignal && abortHandler) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
      };

      const finish = (result: BinaryCommandResult, abortHandler: (() => void) | null): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        cleanupAbortListener(abortHandler);
        resolve(result);
      };

      const timeout = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, timeoutMs);

      const abortHandler = abortSignal
        ? (): void => {
            if (!settled) {
              wasAborted = true;
              child.kill('SIGKILL');
            }
          }
        : null;

      if (abortSignal && abortHandler) {
        if (abortSignal.aborted) {
          clearTimeout(timeout);
          resolve({
            aborted: true,
            code: -1,
            stderr: 'aborted',
            stdout: Buffer.alloc(0),
          });
          return;
        }

        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      child.stdout.on('data', (data: Buffer) => {
        stdoutChunks.push(data);
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });

      child.on('error', (error) => {
        finish(
          {
            aborted: wasAborted,
            code: -1,
            stderr: `${stderr}\n${error.message}`.trim(),
            stdout: Buffer.concat(stdoutChunks),
          },
          abortHandler,
        );
      });

      child.on('close', (code) => {
        finish(
          {
            aborted: wasAborted,
            code: code ?? -1,
            stderr,
            stdout: Buffer.concat(stdoutChunks),
          },
          abortHandler,
        );
      });
    });
  }
}
