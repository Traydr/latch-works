import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ThumbnailDebugOptions,
  ThumbnailDiagnosticsSnapshot,
  ThumbnailJobPriority,
  ThumbnailWorkerCapabilities,
  ThumbnailWorkerJobResult,
} from '../../shared/thumbnail';
import { RequestAbortError } from '../errors';
import {
  ThumbnailBrokerService,
  type ThumbnailBrokerServiceOptions,
  type ThumbnailPipelineStatus,
} from '../thumbnail/ThumbnailBrokerService';

const MAX_THUMB_MEMORY_ENTRIES = 600;
const MAX_THUMB_DISK_FILES = 5000;
const MAX_THUMB_DISK_FILES_BEFORE_PRUNE = MAX_THUMB_DISK_FILES + 100;
const THUMB_CACHE_VERSION = 'thumb-v2';

type ThumbnailTaskKind = 'image' | 'video';

interface ThumbnailResult {
  bytes: Uint8Array;
  contentType: 'image/webp';
  cacheKey: string;
}

export interface ThumbnailBrokerLike {
  clearCache(): Promise<void>;
  getCapabilities?(): ThumbnailWorkerCapabilities | null;
  getDiagnosticsSnapshot?(): ThumbnailDiagnosticsSnapshot;
  getStatus(): ThumbnailPipelineStatus;
  getThumbnail(
    request: {
      cacheKey: string;
      kind: ThumbnailTaskKind;
      mediaPath: string;
      priority: ThumbnailJobPriority;
      thumbSize: number;
    },
    signal?: AbortSignal,
  ): Promise<ThumbnailWorkerJobResult>;
  getPerformanceSnapshot?(): ThumbnailDiagnosticsSnapshot['timings'];
  recordDiskHit?(durationMs: number): void;
  recordMemoryHit?(durationMs: number): void;
  setDebugOptions?(options: ThumbnailDebugOptions): void;
  shutdown?(): void;
}

interface ThumbnailServiceOptions extends ThumbnailBrokerServiceOptions {
  broker?: ThumbnailBrokerLike;
  cacheRootPath?: string;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function isVideoPath(mediaPath: string): boolean {
  const extension = path.extname(mediaPath).toLowerCase();
  return ['.mp4', '.webm', '.mov', '.mkv'].includes(extension);
}

function buildThumbCacheKey(
  mediaPath: string,
  thumbSize: number,
  mtimeMs: number,
  fileSize: number,
): string {
  return createHash('sha1')
    .update(`${THUMB_CACHE_VERSION}|${mediaPath}|${thumbSize}|${mtimeMs}|${fileSize}`)
    .digest('hex');
}

export function toThumbnailResponse(result: ThumbnailResult): Response {
  return new Response(toArrayBuffer(result.bytes), {
    headers: {
      'cache-control': 'public, max-age=86400',
      'content-type': result.contentType,
    },
  });
}

export class ThumbnailService {
  private readonly broker: ThumbnailBrokerLike;
  private readonly diskCacheDir: string;
  private readonly legacyDiskCacheDir: string;
  private readonly memoryCache = new Map<string, Uint8Array>();
  private readonly ready: Promise<void>;

  private diskCacheFileCount = 0;
  private diskCacheHits = 0;
  private generatedCount = 0;
  private memoryCacheHits = 0;
  private pruneScheduled = false;

  constructor(userDataPath: string, options: ThumbnailServiceOptions = {}) {
    const cacheRootPath = options.cacheRootPath ?? userDataPath;
    this.diskCacheDir = path.join(cacheRootPath, 'frame-view', 'thumbnails');
    this.legacyDiskCacheDir = path.join(userDataPath, 'thumb-cache');
    this.broker =
      options.broker ??
      new ThumbnailBrokerService(userDataPath, {
        childFactory: options.childFactory,
        cacheRootPath,
        imageWorkers: options.imageWorkers,
        videoWorkers: options.videoWorkers,
      });
    this.ready = fs
      .mkdir(this.diskCacheDir, { recursive: true })
      .then(() => this.cleanupLegacyDiskCache())
      .then(() => this.pruneDiskCache())
      .catch(() => {
        this.diskCacheFileCount = 0;
      });
  }

  async getThumbnail(
    mediaPath: string,
    thumbSize: number,
    signal?: AbortSignal,
    priority: ThumbnailJobPriority = 0,
  ): Promise<ThumbnailResult> {
    const requestStartedAt = performance.now();

    if (signal?.aborted) {
      throw new RequestAbortError();
    }

    await this.ready;

    const fileStats = await fs.stat(mediaPath);
    if (!fileStats.isFile()) {
      throw new Error('Media path is not a file');
    }

    const cacheKey = buildThumbCacheKey(mediaPath, thumbSize, fileStats.mtimeMs, fileStats.size);
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached) {
      this.touchMemoryCache(cacheKey, memoryCached);
      this.memoryCacheHits += 1;
      this.broker.recordMemoryHit?.(performance.now() - requestStartedAt);
      return {
        bytes: memoryCached,
        cacheKey,
        contentType: 'image/webp',
      };
    }

    const diskCached = await this.maybeReadDiskThumbnail(cacheKey);
    if (diskCached) {
      this.cacheThumbnailMemory(cacheKey, diskCached);
      this.diskCacheHits += 1;
      this.broker.recordDiskHit?.(performance.now() - requestStartedAt);
      return {
        bytes: diskCached,
        cacheKey,
        contentType: 'image/webp',
      };
    }

    const generated = await this.broker.getThumbnail(
      {
        cacheKey,
        kind: isVideoPath(mediaPath) ? 'video' : 'image',
        mediaPath,
        priority,
        thumbSize,
      },
      signal,
    );

    this.cacheThumbnailMemory(cacheKey, generated.bytes);
    this.generatedCount += 1;
    if (generated.cacheCreated) {
      this.diskCacheFileCount += 1;
      this.scheduleDiskCachePruneIfNeeded();
    }

    return {
      bytes: generated.bytes,
      cacheKey,
      contentType: 'image/webp',
    };
  }

  async clearCache(): Promise<void> {
    this.memoryCache.clear();
    await this.broker.clearCache();
    await this.ready;

    try {
      const entries = await fs.readdir(this.diskCacheDir, { withFileTypes: true });
      const deletionTasks: Promise<void>[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || (!entry.name.endsWith('.png') && !entry.name.endsWith('.webp'))) {
          continue;
        }

        deletionTasks.push(
          fs.unlink(path.join(this.diskCacheDir, entry.name)).catch(() => {
            // Ignore deletion errors.
          }),
        );
      }

      await Promise.all(deletionTasks);
      this.diskCacheFileCount = 0;
    } catch {
      // Ignore clear-cache errors.
    }
  }

  getStatus(): ThumbnailPipelineStatus {
    return this.broker.getStatus();
  }

  getCapabilities(): ThumbnailWorkerCapabilities | null {
    return this.broker.getCapabilities?.() ?? null;
  }

  getDiagnosticsSnapshot(): ThumbnailDiagnosticsSnapshot {
    const brokerDiagnostics = this.broker.getDiagnosticsSnapshot?.() ?? {
      abortedCount: 0,
      diskCacheHits: 0,
      generatedCount: 0,
      imageQueueDepth: 0,
      imageWorkerCount: 0,
      inflightRequests: 0,
      memoryCacheHits: 0,
      recentFailures: [],
      recentWorkerEvents: [],
      sharpDecodeFailureCount: 0,
      timings: null,
      videoExtractionFailureCount: 0,
      videoQueueDepth: 0,
      videoWorkerCount: 0,
      workerCrashCount: 0,
      workerRestartCount: 0,
    };

    return {
      ...brokerDiagnostics,
      diskCacheHits: this.diskCacheHits,
      generatedCount: this.generatedCount,
      memoryCacheHits: this.memoryCacheHits,
    };
  }

  setDebugOptions(options: ThumbnailDebugOptions): void {
    this.broker.setDebugOptions?.(options);
  }

  shutdown(): void {
    this.broker.shutdown?.();
  }

  private cacheThumbnailMemory(cacheKey: string, bytes: Uint8Array): void {
    if (this.memoryCache.has(cacheKey)) {
      this.memoryCache.delete(cacheKey);
    } else if (this.memoryCache.size >= MAX_THUMB_MEMORY_ENTRIES) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
      }
    }

    this.memoryCache.set(cacheKey, bytes);
  }

  private touchMemoryCache(cacheKey: string, bytes: Uint8Array): void {
    this.memoryCache.delete(cacheKey);
    this.memoryCache.set(cacheKey, bytes);
  }

  private getDiskThumbPath(cacheKey: string): string {
    return path.join(this.diskCacheDir, `${cacheKey}.webp`);
  }

  private async cleanupLegacyDiskCache(): Promise<void> {
    if (path.resolve(this.legacyDiskCacheDir) === path.resolve(this.diskCacheDir)) {
      return;
    }

    try {
      await fs.rm(this.legacyDiskCacheDir, { recursive: true, force: true });
    } catch {
      // Ignore legacy cache cleanup errors; thumbnails are derived and can be regenerated.
    }
  }

  private async maybeReadDiskThumbnail(cacheKey: string): Promise<Uint8Array | null> {
    try {
      const raw = await fs.readFile(this.getDiskThumbPath(cacheKey));
      return new Uint8Array(raw);
    } catch {
      return null;
    }
  }

  private scheduleDiskCachePruneIfNeeded(): void {
    if (this.pruneScheduled || this.diskCacheFileCount <= MAX_THUMB_DISK_FILES_BEFORE_PRUNE) {
      return;
    }

    this.pruneScheduled = true;
    void this.pruneDiskCache().finally(() => {
      this.pruneScheduled = false;
    });
  }

  private async pruneDiskCache(): Promise<void> {
    try {
      const entries = await fs.readdir(this.diskCacheDir, { withFileTypes: true });
      const cachedFiles = entries.filter(
        (entry) => entry.isFile() && (entry.name.endsWith('.png') || entry.name.endsWith('.webp')),
      );
      this.diskCacheFileCount = cachedFiles.length;

      if (cachedFiles.length <= MAX_THUMB_DISK_FILES) {
        return;
      }

      const filesWithStats = await Promise.all(
        cachedFiles.map(async (entry) => {
          const fullPath = path.join(this.diskCacheDir, entry.name);
          try {
            const stats = await fs.stat(fullPath);
            return {
              fullPath,
              mtimeMs: stats.mtimeMs,
            };
          } catch {
            return null;
          }
        }),
      );

      const validFiles = filesWithStats
        .filter((item): item is { fullPath: string; mtimeMs: number } => item !== null)
        .sort((left, right) => left.mtimeMs - right.mtimeMs);

      const excess = validFiles.length - MAX_THUMB_DISK_FILES;
      if (excess <= 0) {
        this.diskCacheFileCount = validFiles.length;
        return;
      }

      await Promise.all(
        validFiles.slice(0, excess).map(async (item) => {
          try {
            await fs.unlink(item.fullPath);
          } catch {
            // Ignore deletion errors.
          }
        }),
      );

      this.diskCacheFileCount = MAX_THUMB_DISK_FILES;
    } catch {
      // Ignore disk cache prune errors.
    }
  }
}
