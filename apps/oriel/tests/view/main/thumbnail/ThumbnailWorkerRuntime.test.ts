import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThumbnailMediaTools } from '../../../src/main/thumbnail/ThumbnailWorkerRuntime';
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

  it.each(['png', 'gif', 'avif'] as const)(
    'preserves %s thumbnail pixels and dimensions',
    async (format) => {
      const userDataPath = await createTempDir('frame-view-thumb-fidelity-');
      tempDirs.push(userDataPath);
      const imagePath = path.join(userDataPath, `sample.${format}`);
      const width = 96;
      const height = 64;
      const pixels = Buffer.alloc(width * height * 4);

      for (let index = 0; index < width * height; index += 1) {
        pixels[index * 4] = (index * 17) % 256;
        pixels[index * 4 + 1] = (index * 31) % 256;
        pixels[index * 4 + 2] = (index * 53) % 256;
        pixels[index * 4 + 3] = index % 5 === 0 ? 0 : index % 3 === 0 ? 128 : 255;
      }

      await sharp(pixels, { raw: { width, height, channels: 4 } })
        .toFormat(format)
        .toFile(imagePath);
      const runtime = new ThumbnailWorkerRuntime({ userDataPath });
      await runtime.init();

      const response = await runtime.handleRequest({
        requestId: 1,
        type: 'generate-thumbnail',
        job: {
          cacheKey: 'fidelity',
          kind: 'image',
          mediaPath: imagePath,
          priority: 2,
          thumbSize: 440,
        },
      });

      if (!response?.ok || !('bytes' in response.result)) {
        throw new Error('Expected image thumbnail worker response');
      }

      // Compare against the previous encoder, including transparency and upscaling.
      const previous = await sharp(imagePath, { animated: false, sequentialRead: true })
        .rotate()
        .resize({ width: 440, height: 440, fit: 'inside', withoutEnlargement: false })
        .webp(format === 'avif' ? { quality: 92, effort: 5 } : { lossless: true, effort: 5 })
        .toBuffer();

      if (format === 'avif') {
        expect(Buffer.from(response.result.bytes).equals(previous)).toBe(true);
      }

      const expected = await sharp(previous).raw().toBuffer({ resolveWithObject: true });
      const actual = await sharp(response.result.bytes).raw().toBuffer({ resolveWithObject: true });
      expect(actual.info).toEqual(expected.info);

      // WebP may discard RGB beneath fully transparent pixels at either effort.
      // Compare every alpha byte and all RGB values that can affect rendering.
      for (const data of [actual.data, expected.data]) {
        for (let offset = 0; offset < data.length; offset += 4) {
          if (data[offset + 3] === 0) data.fill(0, offset, offset + 3);
        }
      }

      expect(actual.data.equals(expected.data)).toBe(true);
    },
  );

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
    } satisfies ThumbnailMediaTools;

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
