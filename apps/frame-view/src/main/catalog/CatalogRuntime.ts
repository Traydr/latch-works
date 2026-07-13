import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Result } from 'better-result';
import type {
  CatalogWorkerEvent,
  CatalogWorkerRequest,
  CatalogWorkerResponse,
} from '../../shared/catalog';
import type { MediaItem, ScanEvent, ScanOptions } from '../../shared/types';
import type { MediaIndexService } from '../db/mediaIndexService';
import { MediaIndexService as MediaIndexServiceImpl } from '../db/mediaIndexService';
import {
  CATALOG_BATCH_SIZE,
  CATALOG_FILE_STAT_CONCURRENCY,
  CATALOG_PROGRESS_EVENT_INTERVAL_MS,
} from './catalogScanConstants';

interface ActiveRun {
  cancelled: boolean;
  id: number;
  promise: Promise<void>;
}

interface ScanCandidateFile {
  extension: string;
  fullPath: string;
  mediaType: 'image' | 'video';
  name: string;
}

interface ScanFilters {
  imageExtensions: Set<string>;
  showImages: boolean;
  showVideos: boolean;
  videoExtensions: Set<string>;
}

interface ScanContext {
  discoveredItems: number;
  excludedRootChildPaths: Set<string>;
  filters: ScanFilters;
  lastProgressEmittedAt: number;
  mediaIndexScanId: number | null;
  mediaIndexPersistenceFailed: boolean;
  pendingBatch: MediaItem[];
  pendingProgressPath: string | null;
  queue: string[];
  queueCursor: number;
  scannedDirectories: number;
  startedAt: number;
}

interface CatalogRuntimeOptions {
  emitEvent: (event: CatalogWorkerEvent) => void;
  emitResponse: (response: CatalogWorkerResponse) => void;
  mediaIndexService?: MediaIndexService;
  userDataPath?: string;
}

export class CatalogRuntime {
  private readonly mediaIndexService: MediaIndexService;

  private activeRun: ActiveRun | null = null;
  private runCounter = 0;

  constructor(private readonly options: CatalogRuntimeOptions) {
    this.mediaIndexService =
      options.mediaIndexService ?? new MediaIndexServiceImpl(options.userDataPath ?? '');

    if (!options.mediaIndexService) {
      const initResult = this.mediaIndexService.init();
      if (Result.isError(initResult)) {
        throw initResult.error;
      }
    }
  }

  async handleRequest(request: CatalogWorkerRequest): Promise<void> {
    switch (request.type) {
      case 'start-scan':
        await this.startScan(request.requestId, request.options);
        return;
      case 'cancel-scan':
        this.cancelScan();
        this.options.emitResponse({ requestId: request.requestId, ok: true });
        return;
      case 'get-index-stats': {
        const statsResult = await this.mediaIndexService.getStats();
        if (Result.isError(statsResult)) {
          this.options.emitResponse({
            requestId: request.requestId,
            ok: false,
            error: statsResult.error.message,
          });
          return;
        }

        this.options.emitResponse({
          requestId: request.requestId,
          ok: true,
          result: statsResult.value,
        });
        return;
      }
      case 'clear-index':
        await this.clearIndex(request.requestId);
        return;
      default: {
        const exhaustiveCheck: never = request;
        throw new Error(`Unhandled catalog request: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.cancelScan();
    await this.activeRun?.promise;
  }

  private async startScan(requestId: number, options: ScanOptions): Promise<void> {
    this.cancelScan();

    const run: ActiveRun = {
      cancelled: false,
      id: ++this.runCounter,
      promise: Promise.resolve(),
    };

    this.activeRun = run;
    run.promise = this.executeScan(run, options)
      .catch((error) => {
        const message =
          error instanceof Error ? `Scan failed: ${error.message}` : 'Scan failed unexpectedly';
        this.emitScanEvent({
          type: 'error',
          message,
          runId: run.id,
        });
      })
      .finally(() => {
        if (this.activeRun?.id === run.id) {
          this.activeRun = null;
        }
      });
    this.options.emitResponse({ requestId, ok: true });
  }

  private cancelScan(): void {
    if (!this.activeRun) {
      return;
    }

    this.activeRun.cancelled = true;
  }

  private async clearIndex(requestId: number): Promise<void> {
    if (this.activeRun) {
      this.cancelScan();
      await this.activeRun.promise;
    }

    const clearResult = await this.mediaIndexService.clear();
    if (Result.isError(clearResult)) {
      this.options.emitResponse({ requestId, ok: false, error: clearResult.error.message });
      return;
    }

    this.options.emitResponse({ requestId, ok: true });
  }

  private emitScanEvent(event: ScanEvent): void {
    this.options.emitEvent({
      type: 'scan-event',
      event,
    });
  }

  private isRunActive(run: ActiveRun): boolean {
    return this.activeRun?.id === run.id && !run.cancelled;
  }

  private buildScanFilters(options: ScanOptions): ScanFilters {
    return {
      imageExtensions: new Set(options.filters.imageExtensions.map((ext) => ext.toLowerCase())),
      showImages: options.filters.showImages,
      showVideos: options.filters.showVideos,
      videoExtensions: new Set(options.filters.videoExtensions.map((ext) => ext.toLowerCase())),
    };
  }

  private buildScanContext(options: ScanOptions): ScanContext {
    const excludedRootChildPaths = options.excludedRootChildPaths ?? [];

    return {
      discoveredItems: 0,
      excludedRootChildPaths: new Set(
        excludedRootChildPaths
          .map((excludedPath) => path.resolve(excludedPath))
          .filter((excludedPath) => path.dirname(excludedPath) === path.resolve(options.rootPath)),
      ),
      filters: this.buildScanFilters(options),
      lastProgressEmittedAt: 0,
      mediaIndexScanId: null,
      mediaIndexPersistenceFailed: false,
      pendingBatch: [],
      pendingProgressPath: null,
      queue: [options.rootPath],
      queueCursor: 0,
      scannedDirectories: 0,
      startedAt: Date.now(),
    };
  }

  private async collectDirectoryCandidates(
    run: ActiveRun,
    options: ScanOptions,
    context: ScanContext,
    currentPath: string,
  ): Promise<ScanCandidateFile[] | null> {
    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      directory = await fs.opendir(currentPath, { encoding: 'utf8' });
    } catch {
      if (!this.isRunActive(run)) {
        return null;
      }

      this.emitScanEvent({
        type: 'error',
        message: 'Unable to access directory',
        path: currentPath,
        runId: run.id,
      });
      return [];
    }

    if (!this.isRunActive(run)) {
      return null;
    }

    context.scannedDirectories += 1;
    context.pendingProgressPath = currentPath;
    this.emitProgress(run, context);

    const candidateFiles: ScanCandidateFile[] = [];
    try {
      for await (const entry of directory) {
        if (!this.isRunActive(run)) {
          return null;
        }

        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (options.recursive) {
            if (
              currentPath === options.rootPath &&
              context.excludedRootChildPaths.has(path.resolve(fullPath))
            ) {
              continue;
            }

            context.queue.push(fullPath);
          }
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const extension = path.extname(entry.name).replace('.', '').toLowerCase();
        const isImage =
          context.filters.showImages && context.filters.imageExtensions.has(extension);
        const isVideo =
          context.filters.showVideos && context.filters.videoExtensions.has(extension);
        if (!isImage && !isVideo) {
          continue;
        }

        candidateFiles.push({
          extension,
          fullPath,
          mediaType: isVideo ? 'video' : 'image',
          name: entry.name,
        });
      }
    } catch {
      if (!this.isRunActive(run)) {
        return null;
      }

      this.emitScanEvent({
        type: 'error',
        message: 'Unable to access directory',
        path: currentPath,
        runId: run.id,
      });
      return [];
    }

    return candidateFiles;
  }

  private async statCandidateChunk(
    chunk: ScanCandidateFile[],
  ): Promise<Array<{ item: MediaItem } | { statErrorPath: string }>> {
    return Promise.all(
      chunk.map(async (candidate) => {
        try {
          const stats = await fs.stat(candidate.fullPath);
          const item: MediaItem = {
            id: `${candidate.fullPath}:${stats.size}:${stats.mtimeMs}`,
            path: candidate.fullPath,
            name: candidate.name,
            extension: candidate.extension,
            mediaType: candidate.mediaType,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          };
          return { item };
        } catch {
          return { statErrorPath: candidate.fullPath };
        }
      }),
    );
  }

  private emitProgress(run: ActiveRun, context: ScanContext, force = false): void {
    if (!context.pendingProgressPath) {
      return;
    }

    const now = Date.now();
    if (!force && now - context.lastProgressEmittedAt < CATALOG_PROGRESS_EVENT_INTERVAL_MS) {
      return;
    }

    this.emitScanEvent({
      type: 'progress',
      runId: run.id,
      scannedDirectories: context.scannedDirectories,
      discoveredItems: context.discoveredItems,
      currentPath: context.pendingProgressPath,
    });
    context.pendingProgressPath = null;
    context.lastProgressEmittedAt = now;
  }

  private async flushIndexedBatch(
    run: ActiveRun,
    options: ScanOptions,
    context: ScanContext,
  ): Promise<boolean> {
    if (context.pendingBatch.length === 0) {
      return true;
    }

    if (!this.isRunActive(run)) {
      return false;
    }

    const batchToEmit = context.pendingBatch;
    context.pendingBatch = [];
    this.emitScanEvent({ type: 'batch', runId: run.id, items: batchToEmit });

    if (context.mediaIndexScanId !== null && !context.mediaIndexPersistenceFailed) {
      const upsertResult = await this.mediaIndexService.upsertBatch(
        options.rootPath,
        context.mediaIndexScanId,
        batchToEmit,
      );
      if (Result.isError(upsertResult)) {
        context.mediaIndexPersistenceFailed = true;
        this.emitScanEvent({
          type: 'error',
          message: `Media index update failed: ${upsertResult.error.message}`,
          runId: run.id,
        });
      }
    }

    if (!this.isRunActive(run)) {
      return false;
    }

    return true;
  }

  private async executeScan(run: ActiveRun, options: ScanOptions): Promise<void> {
    const context = this.buildScanContext(options);

    try {
      const startScanResult = await this.mediaIndexService.startScan(
        options.rootPath,
        options.recursive,
      );
      if (Result.isError(startScanResult)) {
        throw startScanResult.error;
      }

      context.mediaIndexScanId = startScanResult.value;
    } catch (error) {
      this.emitScanEvent({
        type: 'error',
        message:
          error instanceof Error
            ? `Media index unavailable: ${error.message}`
            : 'Media index unavailable',
        runId: run.id,
      });
    }

    const cancelCurrentRun = (): void => {
      if (context.mediaIndexScanId !== null) {
        void this.mediaIndexService.cancelScan(context.mediaIndexScanId);
        context.mediaIndexScanId = null;
      }

      this.emitScanEvent({ type: 'cancelled', runId: run.id });
    };

    if (!this.isRunActive(run)) {
      return;
    }

    this.emitScanEvent({
      type: 'reset',
      runId: run.id,
      rootPath: options.rootPath,
      recursive: options.recursive,
    });

    while (context.queueCursor < context.queue.length) {
      if (!this.isRunActive(run)) {
        cancelCurrentRun();
        return;
      }

      const currentPath = context.queue[context.queueCursor];
      context.queueCursor += 1;
      if (!currentPath) {
        continue;
      }

      const candidateFiles = await this.collectDirectoryCandidates(
        run,
        options,
        context,
        currentPath,
      );
      if (candidateFiles === null) {
        cancelCurrentRun();
        return;
      }

      for (
        let startIndex = 0;
        startIndex < candidateFiles.length;
        startIndex += CATALOG_FILE_STAT_CONCURRENCY
      ) {
        if (!this.isRunActive(run)) {
          cancelCurrentRun();
          return;
        }

        const chunk = candidateFiles.slice(startIndex, startIndex + CATALOG_FILE_STAT_CONCURRENCY);
        const chunkResults = await this.statCandidateChunk(chunk);
        if (!this.isRunActive(run)) {
          cancelCurrentRun();
          return;
        }

        for (const result of chunkResults) {
          if ('statErrorPath' in result) {
            this.emitScanEvent({
              type: 'error',
              message: 'Unable to stat file',
              path: result.statErrorPath,
              runId: run.id,
            });
            continue;
          }

          context.pendingBatch.push(result.item);
          context.discoveredItems += 1;

          if (
            context.pendingBatch.length >= CATALOG_BATCH_SIZE &&
            !(await this.flushIndexedBatch(run, options, context))
          ) {
            cancelCurrentRun();
            return;
          }
        }
      }

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    if (!this.isRunActive(run)) {
      cancelCurrentRun();
      return;
    }

    if (context.pendingBatch.length > 0 && !(await this.flushIndexedBatch(run, options, context))) {
      cancelCurrentRun();
      return;
    }

    this.emitProgress(run, context, true);

    if (!this.isRunActive(run)) {
      cancelCurrentRun();
      return;
    }

    if (context.mediaIndexScanId !== null) {
      if (context.mediaIndexPersistenceFailed) {
        const cancelResult = await this.mediaIndexService.cancelScan(context.mediaIndexScanId);
        if (Result.isError(cancelResult)) {
          this.emitScanEvent({
            type: 'error',
            message: `Media index cancellation failed: ${cancelResult.error.message}`,
            runId: run.id,
          });
        }

        this.emitScanEvent({ type: 'cancelled', runId: run.id });
        return;
      }

      const finishResult = await this.mediaIndexService.finishScan(
        options.rootPath,
        context.mediaIndexScanId,
      );
      if (Result.isError(finishResult)) {
        this.emitScanEvent({
          type: 'error',
          message: `Media index finalize failed: ${finishResult.error.message}`,
          runId: run.id,
        });

        const cancelResult = await this.mediaIndexService.cancelScan(context.mediaIndexScanId);
        if (Result.isError(cancelResult)) {
          this.emitScanEvent({
            type: 'error',
            message: `Media index cancellation failed: ${cancelResult.error.message}`,
            runId: run.id,
          });
        }

        this.emitScanEvent({ type: 'cancelled', runId: run.id });
        return;
      }
    }

    this.emitScanEvent({
      type: 'done',
      runId: run.id,
      totalItems: context.discoveredItems,
      elapsedMs: Date.now() - context.startedAt,
    });
  }
}
