import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Result, type Result as ResultType } from 'better-result';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type CatalogMediaIndex, CatalogRuntime } from '../../../src/main/catalog/CatalogRuntime';
import { DatabaseError } from '../../../src/main/errors';
import type { CatalogWorkerEvent, CatalogWorkerResponse } from '../../../src/shared/catalog';
import { DEFAULT_SETTINGS, type MediaIndexStats, type MediaItem } from '../../../src/shared/types';
import { waitForCondition } from '../../testUtils';

/**
 * An in-memory stand-in for the SQLite media index: the runtime only needs scan bookkeeping,
 * and every scan assertion here is about the events the runtime emits.
 */
class InMemoryMediaIndex implements CatalogMediaIndex {
  private readonly items = new Map<string, { rootPath: string; lastSeenScanId: number }>();
  private nextScanId = 1;

  init(): ResultType<void, DatabaseError> {
    return Result.ok();
  }

  async startScan(): Promise<ResultType<number, DatabaseError>> {
    return Result.ok(this.nextScanId++);
  }

  async upsertBatch(
    rootPath: string,
    scanId: number,
    items: MediaItem[],
  ): Promise<ResultType<void, DatabaseError>> {
    for (const item of items) {
      this.items.set(item.path, {
        rootPath,
        lastSeenScanId: scanId,
      });
    }
    return Result.ok();
  }

  async finishScan(rootPath: string, scanId: number): Promise<ResultType<void, DatabaseError>> {
    for (const [itemPath, item] of this.items) {
      if (item.rootPath === rootPath && item.lastSeenScanId !== scanId) {
        this.items.delete(itemPath);
      }
    }
    return Result.ok();
  }

  async cancelScan(): Promise<ResultType<void, DatabaseError>> {
    return Result.ok();
  }

  async clear(): Promise<ResultType<void, DatabaseError>> {
    this.items.clear();
    return Result.ok();
  }

  async getStats(): Promise<ResultType<MediaIndexStats, DatabaseError>> {
    const roots = new Set(Array.from(this.items.values(), (item) => item.rootPath));
    return Result.ok({
      totalItems: this.items.size,
      uniqueRoots: roots.size,
      dbPath: 'mock-media-index.sqlite',
    });
  }
}

function indexError(message: string): DatabaseError {
  return new DatabaseError({ operation: 'media-index', message });
}

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createMediaTree(
  rootPath: string,
  directories: number,
  filesPerDirectory: number,
): Promise<void> {
  for (let directoryIndex = 0; directoryIndex < directories; directoryIndex += 1) {
    const directoryPath =
      directoryIndex === 0 ? rootPath : path.join(rootPath, `dir-${directoryIndex}`);
    if (directoryIndex > 0) {
      await mkdir(directoryPath, { recursive: true });
    }

    for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex += 1) {
      await writeFile(path.join(directoryPath, `image-${fileIndex}.jpg`), 'frame-view');
    }
  }
}

describe('CatalogRuntime', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (directoryPath) => {
        await rm(directoryPath, { recursive: true, force: true });
      }),
    );
    tempDirs.length = 0;
  });

  it('emits reset, progress, batch, and done in order for a scan', async () => {
    const userDataPath = await createTempDir('frame-view-catalog-user-');
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(userDataPath, rootPath);

    await createMediaTree(rootPath, 1, 2);

    const events: CatalogWorkerEvent[] = [];
    const responses: CatalogWorkerResponse[] = [];
    const runtime = new CatalogRuntime({
      userDataPath,
      emitEvent: (event) => events.push(event),
      emitResponse: (response) => responses.push(response),
      mediaIndexService: new InMemoryMediaIndex(),
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: false,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'done'));

    expect(responses).toEqual([{ requestId: 1, ok: true }]);
    expect(events.map((event) => event.event.type)).toEqual(['reset', 'progress', 'batch', 'done']);
    expect(events[0]?.event).toMatchObject({ type: 'reset', recursive: false });
    expect(events.at(-1)?.event).toMatchObject({
      type: 'done',
      totalItems: 2,
    });
  });

  it('discovers AVIF images with the default filters', async () => {
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(rootPath);
    await writeFile(path.join(rootPath, 'image.avif'), 'frame-view');

    const events: CatalogWorkerEvent[] = [];
    const runtime = new CatalogRuntime({
      emitEvent: (event) => events.push(event),
      emitResponse: () => {
        // No-op.
      },
      mediaIndexService: new InMemoryMediaIndex(),
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: false,
        filters: DEFAULT_SETTINGS.filters,
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'done'));

    const scannedItems = events
      .map((event) => event.event)
      .filter((event) => event.type === 'batch')
      .flatMap((event) => event.items);

    expect(scannedItems).toEqual([
      expect.objectContaining({
        extension: 'avif',
        mediaType: 'image',
        name: 'image.avif',
      }),
    ]);
    expect(events.at(-1)?.event).toMatchObject({ type: 'done', totalItems: 1 });
  });

  it('skips excluded direct root children but not nested names', async () => {
    const userDataPath = await createTempDir('frame-view-catalog-user-');
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(userDataPath, rootPath);

    const includedPath = path.join(rootPath, 'included');
    const excludedPath = path.join(rootPath, 'excluded');
    const nestedExcludedPath = path.join(includedPath, 'excluded');
    await mkdir(includedPath, { recursive: true });
    await mkdir(excludedPath, { recursive: true });
    await mkdir(nestedExcludedPath, { recursive: true });
    await writeFile(path.join(includedPath, 'included.jpg'), 'frame-view');
    await writeFile(path.join(excludedPath, 'excluded.jpg'), 'frame-view');
    await writeFile(path.join(nestedExcludedPath, 'nested.jpg'), 'frame-view');

    const events: CatalogWorkerEvent[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      userDataPath,
      emitEvent: (event) => events.push(event),
      emitResponse: () => {
        // No-op.
      },
      mediaIndexService: new InMemoryMediaIndex(),
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: true,
        excludedRootChildPaths: [excludedPath, nestedExcludedPath],
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'done'));

    const scannedPaths = events
      .map((event) => event.event)
      .filter((event) => event.type === 'batch')
      .flatMap((event) => event.items.map((item) => item.path));

    expect(scannedPaths).toContain(path.join(includedPath, 'included.jpg'));
    expect(scannedPaths).toContain(path.join(nestedExcludedPath, 'nested.jpg'));
    expect(scannedPaths).not.toContain(path.join(excludedPath, 'excluded.jpg'));
  });

  it('cancels an active scan without emitting stale done events', async () => {
    const userDataPath = await createTempDir('frame-view-catalog-user-');
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(userDataPath, rootPath);

    await createMediaTree(rootPath, 24, 4);

    const events: CatalogWorkerEvent[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      userDataPath,
      emitEvent: (event) => {
        events.push(event);

        if (
          event.event.type === 'progress' &&
          event.event.currentPath === rootPath &&
          !events.some((candidate) => candidate.event.type === 'cancelled')
        ) {
          void runtime.handleRequest({ requestId: 2, type: 'cancel-scan' });
        }
      },
      emitResponse: () => {
        // Responses are not relevant for this assertion.
      },
      mediaIndexService: new InMemoryMediaIndex(),
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: true,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'cancelled'));

    const cancelledIndex = events.findIndex((event) => event.event.type === 'cancelled');
    const trailingEventTypes = events.slice(cancelledIndex + 1).map((event) => event.event.type);

    expect(events.some((event) => event.event.type === 'done')).toBe(false);
    expect(trailingEventTypes.includes('batch')).toBe(false);
    expect(trailingEventTypes.includes('done')).toBe(false);
  });

  it('clears the index after cancelling an active scan', async () => {
    const userDataPath = await createTempDir('frame-view-catalog-user-');
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(userDataPath, rootPath);

    await createMediaTree(rootPath, 18, 6);

    const events: CatalogWorkerEvent[] = [];
    const responses: CatalogWorkerResponse[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      userDataPath,
      emitEvent: (event) => {
        events.push(event);

        if (
          event.event.type === 'progress' &&
          event.event.currentPath === rootPath &&
          !responses.some((response) => response.requestId === 2)
        ) {
          void runtime.handleRequest({ requestId: 2, type: 'clear-index' });
        }
      },
      emitResponse: (response) => responses.push(response),
      mediaIndexService: new InMemoryMediaIndex(),
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: true,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => responses.some((response) => response.requestId === 2));

    await runtime.handleRequest({ requestId: 3, type: 'get-index-stats' });

    const statsResponse = responses.find((response) => response.requestId === 3);
    expect(events.some((event) => event.event.type === 'cancelled')).toBe(true);
    expect(statsResponse).toMatchObject({
      requestId: 3,
      ok: true,
      result: {
        totalItems: 0,
      },
    });
  });

  it('cancels cleanly while a batch flush is in progress', async () => {
    let releaseUpsert: (() => void) | null = null;
    const mediaIndexService = {
      init: () => Result.ok(),
      startScan: async () => Result.ok(1),
      upsertBatch: async () => {
        await new Promise<void>((resolve) => {
          releaseUpsert = resolve;
        });
        return Result.ok();
      },
      finishScan: async () => Result.ok(),
      cancelScan: async () => Result.ok(),
      clear: async () => Result.ok(),
      getStats: async () =>
        Result.ok({
          totalItems: 0,
          uniqueRoots: 0,
          dbPath: 'mock-media-index.sqlite',
        }),
    };
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(rootPath);
    await createMediaTree(rootPath, 1, 310);

    const events: CatalogWorkerEvent[] = [];
    const responses: CatalogWorkerResponse[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      emitEvent: (event) => events.push(event),
      emitResponse: (response) => responses.push(response),
      mediaIndexService,
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: false,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => releaseUpsert !== null);
    await runtime.handleRequest({ requestId: 2, type: 'cancel-scan' });
    releaseUpsert?.();

    await waitForCondition(() => events.some((event) => event.event.type === 'cancelled'));

    expect(responses).toContainEqual({ requestId: 2, ok: true });
    expect(events.some((event) => event.event.type === 'done')).toBe(false);
  });

  it('throttles progress events during fast scans', async () => {
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(rootPath);
    await createMediaTree(rootPath, 5, 1);

    let nowCallCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCallCount += 1;
      return nowCallCount < 20 ? 100 : 300;
    });

    const events: CatalogWorkerEvent[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      userDataPath: rootPath,
      emitEvent: (event) => events.push(event),
      emitResponse: () => {
        // No-op.
      },
      mediaIndexService: new InMemoryMediaIndex(),
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: true,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'done'));

    const progressEvents = events.filter((event) => event.event.type === 'progress');
    expect(progressEvents.length).toBeLessThan(5);
    expect(progressEvents.length).toBeGreaterThan(0);
  });

  it('preserves item count for large streamed directories', async () => {
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(rootPath);
    await createMediaTree(rootPath, 1, 1200);

    const events: CatalogWorkerEvent[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      userDataPath: rootPath,
      emitEvent: (event) => events.push(event),
      emitResponse: () => {
        // No-op.
      },
      mediaIndexService: new InMemoryMediaIndex(),
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: false,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'done'));

    const batchTotal = events
      .map((event) => event.event)
      .filter((event) => event.type === 'batch')
      .reduce((total, event) => total + event.items.length, 0);

    expect(batchTotal).toBe(1200);
    expect(events.at(-1)?.event).toMatchObject({ type: 'done', totalItems: 1200 });
  });

  it('emits an access error when a queued path cannot be opened as a directory', async () => {
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(rootPath);
    const filePath = path.join(rootPath, 'not-a-directory.jpg');
    await writeFile(filePath, 'frame-view');

    const events: CatalogWorkerEvent[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      userDataPath: rootPath,
      emitEvent: (event) => events.push(event),
      emitResponse: () => {
        // No-op.
      },
      mediaIndexService: new InMemoryMediaIndex(),
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath: filePath,
        recursive: false,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'done'));

    expect(events.some((event) => event.event.type === 'error')).toBe(true);
    expect(events.find((event) => event.event.type === 'error')?.event).toMatchObject({
      message: 'Unable to access directory',
      path: filePath,
    });
  });

  it.each([
    1, 2, 3,
  ])('cancels a degraded scan when durable batch %i fails without removing old rows', async (failedBatch) => {
    const oldItemPath = '/existing/old.jpg';
    const persistedItems = new Map([[oldItemPath, { rootPath: '', lastSeenScanId: 0 }]]);
    let upsertCalls = 0;
    const finishScan = vi.fn(async () => Result.ok());
    const cancelScan = vi.fn(async () => Result.ok());
    const mediaIndexService = {
      init: () => Result.ok(),
      startScan: async (rootPath: string) => {
        persistedItems.set(oldItemPath, { rootPath, lastSeenScanId: 0 });
        return Result.ok(1);
      },
      upsertBatch: async (rootPath: string, scanId: number, items: Array<{ path: string }>) => {
        upsertCalls += 1;
        if (upsertCalls === failedBatch) {
          return Result.err(indexError('index unavailable'));
        }

        for (const item of items) {
          persistedItems.set(item.path, { rootPath, lastSeenScanId: scanId });
        }
        return Result.ok();
      },
      finishScan,
      cancelScan,
      clear: async () => Result.ok(),
      getStats: async () =>
        Result.ok({
          totalItems: persistedItems.size,
          uniqueRoots: 1,
          dbPath: 'mock-media-index.sqlite',
        }),
    };
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(rootPath);
    await createMediaTree(rootPath, 1, 610);

    const events: CatalogWorkerEvent[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      emitEvent: (event) => events.push(event),
      emitResponse: () => {
        // No-op.
      },
      mediaIndexService,
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: false,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'cancelled'));

    const batchTotal = events
      .map((event) => event.event)
      .filter((event) => event.type === 'batch')
      .reduce((total, event) => total + event.items.length, 0);
    expect(batchTotal).toBe(610);
    expect(upsertCalls).toBe(failedBatch);
    expect(finishScan).not.toHaveBeenCalled();
    expect(cancelScan).toHaveBeenCalledWith(1);
    expect(persistedItems.get(oldItemPath)).toEqual({ rootPath, lastSeenScanId: 0 });
    expect(events.some((event) => event.event.type === 'done')).toBe(false);
  });

  it('reports a durable cancellation failure but still emits a terminal cancelled event', async () => {
    const cancelScan = vi.fn(async () => Result.err(indexError('database unavailable')));
    const mediaIndexService = {
      init: () => Result.ok(),
      startScan: async () => Result.ok(1),
      upsertBatch: async () => Result.err(indexError('index unavailable')),
      finishScan: async () => Result.ok(),
      cancelScan,
      clear: async () => Result.ok(),
      getStats: async () =>
        Result.ok({ totalItems: 0, uniqueRoots: 0, dbPath: 'mock-media-index.sqlite' }),
    };
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(rootPath);
    await createMediaTree(rootPath, 1, 2);

    const events: CatalogWorkerEvent[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      emitEvent: (event) => events.push(event),
      emitResponse: () => {
        // No-op.
      },
      mediaIndexService,
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: false,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'cancelled'));

    expect(cancelScan).toHaveBeenCalledWith(1);
    expect(events.map((event) => event.event)).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'Media index cancellation failed: database unavailable',
      }),
    );
    expect(events.some((event) => event.event.type === 'done')).toBe(false);
  });

  it('does not report a failed durable finalization as a successful scan', async () => {
    const finishScan = vi.fn(async () => Result.err(indexError('database unavailable')));
    const cancelScan = vi.fn(async () => Result.ok());
    const mediaIndexService = {
      init: () => Result.ok(),
      startScan: async () => Result.ok(1),
      upsertBatch: async () => Result.ok(),
      finishScan,
      cancelScan,
      clear: async () => Result.ok(),
      getStats: async () =>
        Result.ok({ totalItems: 0, uniqueRoots: 0, dbPath: 'mock-media-index.sqlite' }),
    };
    const rootPath = await createTempDir('frame-view-catalog-root-');
    tempDirs.push(rootPath);
    await createMediaTree(rootPath, 1, 2);

    const events: CatalogWorkerEvent[] = [];
    const { CatalogRuntime } = await import('../../../src/main/catalog/CatalogRuntime');
    const runtime = new CatalogRuntime({
      emitEvent: (event) => events.push(event),
      emitResponse: () => {
        // No-op.
      },
      mediaIndexService,
    });

    await runtime.handleRequest({
      requestId: 1,
      type: 'start-scan',
      options: {
        rootPath,
        recursive: false,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: [],
          showImages: true,
          showVideos: false,
        },
      },
    });

    await waitForCondition(() => events.some((event) => event.event.type === 'cancelled'));

    expect(finishScan).toHaveBeenCalledWith(rootPath, 1);
    expect(cancelScan).toHaveBeenCalledWith(1);
    expect(events.map((event) => event.event)).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'Media index finalize failed: database unavailable',
      }),
    );
    expect(events.some((event) => event.event.type === 'done')).toBe(false);
  });
});
