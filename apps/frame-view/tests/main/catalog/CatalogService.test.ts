import { EventEmitter } from 'node:events';

import { Result } from 'better-result';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type CatalogChildProcessLike,
  CatalogService,
} from '../../../src/main/catalog/CatalogService';
import type { CatalogWorkerRequest } from '../../../src/shared/catalog';
import type { ScanEvent } from '../../../src/shared/types';

class FakeCatalogChild extends EventEmitter implements CatalogChildProcessLike {
  public readonly postedMessages: CatalogWorkerRequest[] = [];
  public killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  postMessage(message: CatalogWorkerRequest): void {
    this.postedMessages.push(message);
  }
}

describe('CatalogService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a terminal error for an active scan crash and restarts lazily on the next request', async () => {
    const children: FakeCatalogChild[] = [];
    const childFactory = vi.fn((modulePath: string, args: string[]) => {
      void modulePath;
      void args;
      const child = new FakeCatalogChild();
      children.push(child);
      return child;
    });

    const emittedScanEvents: ScanEvent[] = [];
    const service = new CatalogService(
      'C:\\frame-view-user',
      (event) => {
        emittedScanEvents.push(event);
      },
      childFactory,
    );

    const startScanPromise = service.startScan({
      rootPath: 'C:\\gallery',
      recursive: true,
      filters: {
        imageExtensions: ['jpg'],
        videoExtensions: [],
        showImages: true,
        showVideos: false,
      },
    });

    const firstChild = children[0];
    expect(firstChild).toBeDefined();

    const startRequestId = firstChild?.postedMessages[0]?.requestId;
    expect(startRequestId).toBeTypeOf('number');

    firstChild?.emit('message', { requestId: startRequestId, ok: true });
    await startScanPromise;

    firstChild?.emit('message', {
      type: 'scan-event',
      event: {
        type: 'reset',
        runId: 41,
        rootPath: 'C:\\gallery',
        recursive: true,
      },
    });

    firstChild?.emit('exit', 1);

    expect(emittedScanEvents).toEqual([
      { type: 'reset', runId: 41, rootPath: 'C:\\gallery', recursive: true },
      { type: 'cancelled', runId: 41 },
      { type: 'error', message: 'Catalog worker exited unexpectedly' },
    ]);

    const getStatsPromise = service.getMediaIndexStats();
    const secondChild = children[1];
    expect(secondChild).toBeDefined();
    expect(childFactory).toHaveBeenCalledTimes(2);

    const statsRequestId = secondChild?.postedMessages[0]?.requestId;
    secondChild?.emit('message', {
      requestId: statsRequestId,
      ok: true,
      result: {
        totalItems: 0,
        uniqueRoots: 0,
        dbPath: 'C:\\frame-view-user\\media-index.sqlite',
      },
    });

    const getStatsResult = await getStatsPromise;
    expect(Result.isOk(getStatsResult)).toBe(true);
    if (Result.isError(getStatsResult)) {
      throw new Error(getStatsResult.error.message);
    }

    expect(getStatsResult.value).toEqual({
      totalItems: 0,
      uniqueRoots: 0,
      dbPath: 'C:\\frame-view-user\\media-index.sqlite',
    });

    service.shutdown();
    expect(secondChild?.killed).toBe(true);
  });
});
