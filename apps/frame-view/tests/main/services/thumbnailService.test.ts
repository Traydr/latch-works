import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ThumbnailBrokerLike } from '../../../src/main/services/thumbnailService';
import { ThumbnailService } from '../../../src/main/services/thumbnailService';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSampleImage(targetPath: string): Promise<void> {
  const buffer = await sharp({
    create: {
      width: 48,
      height: 32,
      channels: 3,
      background: {
        r: 210,
        g: 48,
        b: 90,
      },
    },
  })
    .png()
    .toBuffer();

  await writeFile(targetPath, buffer);
}

async function createSampleWebp(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: {
        width: 64,
        height: 40,
        channels: 3,
        background: {
          r: 40,
          g: 80,
          b: 180,
        },
      },
    })
      .webp()
      .toBuffer(),
  );
}

function createBrokerStub(
  cacheRootPath: string,
  overrides?: {
    clearCache?: () => Promise<void>;
    getThumbnail?: ThumbnailBrokerLike['getThumbnail'];
  },
): ThumbnailBrokerLike {
  return {
    clearCache:
      overrides?.clearCache ??
      (async () => {
        return undefined;
      }),
    getStatus: () => ({
      ffmpegAvailable: true,
      imageQueueDepth: 0,
      imageWorkerCount: 2,
      inflightRequests: 0,
      sharpAvailable: true,
      videoQueueDepth: 0,
      videoWorkerCount: 1,
    }),
    getThumbnail:
      overrides?.getThumbnail ??
      (async (request) => {
        const bytes = await createSampleWebp();
        await writeFile(
          path.join(cacheRootPath, 'frame-view', 'thumbnails', `${request.cacheKey}.webp`),
          bytes,
        );
        return {
          bytes,
          cacheCreated: true,
          cacheKey: request.cacheKey,
          contentType: 'image/webp',
        };
      }),
    shutdown: () => undefined,
  };
}

describe('ThumbnailService', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.map(async (dirPath) => {
        await rm(dirPath, { recursive: true, force: true });
      }),
    );
    tempDirs.length = 0;
  });

  it('returns generated webp thumbnails and caches them in memory', async () => {
    const userDataPath = await createTempDir('frame-view-thumb-user-');
    const cacheRootPath = await createTempDir('frame-view-thumb-cache-');
    tempDirs.push(userDataPath, cacheRootPath);

    const imagePath = path.join(userDataPath, 'sample.png');
    await createSampleImage(imagePath);

    let brokerCalls = 0;
    const broker = createBrokerStub(userDataPath, {
      getThumbnail: async (request) => {
        brokerCalls += 1;
        const bytes = await createSampleWebp();
        await writeFile(
          path.join(cacheRootPath, 'frame-view', 'thumbnails', `${request.cacheKey}.webp`),
          bytes,
        );
        return {
          bytes,
          cacheCreated: true,
          cacheKey: request.cacheKey,
          contentType: 'image/webp',
        };
      },
    });

    const service = new ThumbnailService(userDataPath, { broker, cacheRootPath });
    const first = await service.getThumbnail(imagePath, 220);
    const second = await service.getThumbnail(imagePath, 220);

    expect(first.contentType).toBe('image/webp');
    expect(first.bytes).toEqual(second.bytes);
    expect(brokerCalls).toBe(1);
  });

  it('reuses the disk cache instead of asking the broker again', async () => {
    const userDataPath = await createTempDir('frame-view-thumb-user-');
    const cacheRootPath = await createTempDir('frame-view-thumb-cache-');
    tempDirs.push(userDataPath, cacheRootPath);

    const imagePath = path.join(userDataPath, 'disk-cache-source.png');
    await createSampleImage(imagePath);

    const firstService = new ThumbnailService(userDataPath, {
      broker: createBrokerStub(cacheRootPath),
      cacheRootPath,
    });
    await firstService.getThumbnail(imagePath, 220);

    let brokerCalls = 0;
    const secondService = new ThumbnailService(userDataPath, {
      broker: createBrokerStub(cacheRootPath, {
        getThumbnail: async () => {
          brokerCalls += 1;
          return {
            bytes: await createSampleWebp(),
            cacheCreated: false,
            cacheKey: 'ignored',
            contentType: 'image/webp',
          };
        },
      }),
      cacheRootPath,
    });

    const result = await secondService.getThumbnail(imagePath, 220);

    expect(result.contentType).toBe('image/webp');
    expect(await stat(path.join(cacheRootPath, 'frame-view', 'thumbnails'))).toBeDefined();
    expect(brokerCalls).toBe(0);
  });

  it('clears both legacy png and new webp cache files and delegates cancellation to the broker', async () => {
    const userDataPath = await createTempDir('frame-view-thumb-user-');
    const cacheRootPath = await createTempDir('frame-view-thumb-cache-');
    tempDirs.push(userDataPath, cacheRootPath);

    const imagePath = path.join(userDataPath, 'clear-source.png');
    await createSampleImage(imagePath);

    let clearCalls = 0;
    const service = new ThumbnailService(userDataPath, {
      broker: createBrokerStub(cacheRootPath, {
        clearCache: async () => {
          clearCalls += 1;
        },
      }),
      cacheRootPath,
    });
    await service.getThumbnail(imagePath, 220);

    const legacyDir = path.join(cacheRootPath, 'frame-view', 'thumbnails');
    const legacyPngPath = path.join(legacyDir, 'legacy-thumb.png');
    await writeFile(legacyPngPath, Buffer.from('legacy'));

    await service.clearCache();

    const remainingEntries = await readdir(legacyDir);
    expect(
      remainingEntries.filter((entry) => entry.endsWith('.png') || entry.endsWith('.webp')),
    ).toEqual([]);
    expect(clearCalls).toBe(1);
  });

  it('removes the old user-data thumbnail cache after using the OS cache root', async () => {
    const userDataPath = await createTempDir('frame-view-thumb-user-');
    const cacheRootPath = await createTempDir('frame-view-thumb-cache-');
    tempDirs.push(userDataPath, cacheRootPath);
    const oldCacheDir = path.join(userDataPath, 'thumb-cache');
    await mkdir(oldCacheDir, { recursive: true });
    await writeFile(path.join(oldCacheDir, 'stale.webp'), Buffer.from('stale'));

    const service = new ThumbnailService(userDataPath, {
      broker: createBrokerStub(cacheRootPath),
      cacheRootPath,
    });
    const imagePath = path.join(userDataPath, 'cleanup-source.png');
    await createSampleImage(imagePath);

    await service.getThumbnail(imagePath, 220);

    await expect(stat(oldCacheDir)).rejects.toThrow();
    expect(await stat(path.join(cacheRootPath, 'frame-view', 'thumbnails'))).toBeDefined();
  });
});
