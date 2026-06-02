import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaToolsService } from '../../../src/main/services/mediaToolsService';
import { ThumbnailWorkerRuntime } from '../../../src/main/thumbnail/ThumbnailWorkerRuntime';

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSampleImage(targetPath: string): Promise<void> {
  const buffer = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: {
        r: 120,
        g: 200,
        b: 80,
      },
    },
  })
    .png()
    .toBuffer();

  await writeFile(targetPath, buffer);
}

async function createSampleFrame(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: {
        r: 20,
        g: 60,
        b: 180,
      },
    },
  })
    .png()
    .toBuffer();
}

describe('ThumbnailWorkerRuntime', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dirPath) => {
        await rm(dirPath, { recursive: true, force: true });
      }),
    );
    tempDirs.length = 0;
  });

  it('generates image thumbnails as webp and writes them to disk', async () => {
    const userDataPath = await createTempDir('frame-view-thumb-worker-');
    const cacheRootPath = await createTempDir('frame-view-thumb-worker-cache-');
    tempDirs.push(userDataPath, cacheRootPath);

    const imagePath = path.join(userDataPath, 'sample.png');
    await createSampleImage(imagePath);

    const runtime = new ThumbnailWorkerRuntime({ cacheRootPath, userDataPath });
    await runtime.init();

    const response = await runtime.handleRequest({
      requestId: 1,
      type: 'generate-thumbnail',
      job: {
        cacheKey: 'image-key',
        kind: 'image',
        mediaPath: imagePath,
        priority: 2,
        thumbSize: 220,
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: expect.objectContaining({
        cacheCreated: true,
        contentType: 'image/webp',
      }),
    });

    if (!response?.ok || !('bytes' in response.result)) {
      throw new Error('Expected image thumbnail worker response');
    }

    expect((await sharp(response.result.bytes).metadata()).format).toBe('webp');
    expect(
      await readFile(path.join(cacheRootPath, 'frame-view', 'thumbnails', 'image-key.webp')),
    ).toBeDefined();
  });

  it('generates video thumbnails from extracted frames and writes them to disk', async () => {
    const userDataPath = await createTempDir('frame-view-thumb-worker-');
    const cacheRootPath = await createTempDir('frame-view-thumb-worker-cache-');
    tempDirs.push(userDataPath, cacheRootPath);

    const videoPath = path.join(userDataPath, 'sample.mp4');
    await writeFile(videoPath, 'video');

    const mediaToolsService = {
      extractVideoFrame: async () => createSampleFrame(),
      getStatus: () => ({
        ffmpegAvailable: true,
        ffprobeAvailable: true,
        ffmpegPath: 'mock-ffmpeg',
        ffprobePath: 'mock-ffprobe',
      }),
      probeVideo: async () => null,
    } as unknown as MediaToolsService;

    const runtime = new ThumbnailWorkerRuntime({
      cacheRootPath,
      mediaToolsService,
      userDataPath,
    });
    await runtime.init();

    const response = await runtime.handleRequest({
      requestId: 2,
      type: 'generate-thumbnail',
      job: {
        cacheKey: 'video-key',
        kind: 'video',
        mediaPath: videoPath,
        priority: 2,
        thumbSize: 220,
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: expect.objectContaining({
        cacheCreated: true,
        contentType: 'image/webp',
      }),
    });

    if (!response?.ok || !('bytes' in response.result)) {
      throw new Error('Expected video thumbnail worker response');
    }

    expect((await sharp(response.result.bytes).metadata()).format).toBe('webp');
    expect(
      await readFile(path.join(cacheRootPath, 'frame-view', 'thumbnails', 'video-key.webp')),
    ).toBeDefined();
  });
});
