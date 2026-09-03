import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Result } from 'better-result';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MediaIndexService } from '../../../src/main/db/mediaIndexService';
import type { MediaItem } from '../../../src/shared/types';

function mediaItem(rootPath: string, name: string): MediaItem {
  const itemPath = path.join(rootPath, name);
  return {
    id: `${itemPath}:1:2`,
    path: itemPath,
    name,
    extension: 'jpg',
    mediaType: 'image',
    size: 1,
    mtimeMs: 2,
  };
}

function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (Result.isError(result)) {
    throw result.error;
  }

  return result.value;
}

describe('MediaIndexService', () => {
  let userDataPath: string;
  let service: MediaIndexService;

  beforeEach(async () => {
    userDataPath = await mkdtemp(path.join(os.tmpdir(), 'media-index-'));
    service = new MediaIndexService(userDataPath);
    unwrap(service.init());
  });

  afterEach(async () => {
    await rm(userDataPath, { force: true, recursive: true });
  });

  it('persists a scan and drops rows the next scan of the same root no longer sees', async () => {
    const rootPath = path.join(userDataPath, 'root');

    const firstScanId = unwrap(await service.startScan(rootPath, false));
    expect(firstScanId).toBe(1);
    unwrap(
      await service.upsertBatch(rootPath, firstScanId, [
        mediaItem(rootPath, 'a.jpg'),
        mediaItem(rootPath, 'b.jpg'),
      ]),
    );
    unwrap(await service.finishScan(rootPath, firstScanId));
    expect(unwrap(await service.getStats())).toMatchObject({ totalItems: 2, uniqueRoots: 1 });

    const secondScanId = unwrap(await service.startScan(rootPath, false));
    expect(secondScanId).toBe(2);
    unwrap(await service.upsertBatch(rootPath, secondScanId, [mediaItem(rootPath, 'b.jpg')]));
    unwrap(await service.finishScan(rootPath, secondScanId));
    expect(unwrap(await service.getStats())).toMatchObject({ totalItems: 1, uniqueRoots: 1 });

    unwrap(await service.clear());
    expect(unwrap(await service.getStats())).toMatchObject({ totalItems: 0, uniqueRoots: 0 });
  });
});
