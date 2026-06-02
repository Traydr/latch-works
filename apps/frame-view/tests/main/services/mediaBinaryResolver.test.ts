import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveBinaryPath } from '../../../src/main/services/mediaBinaryResolver';

describe('mediaBinaryResolver', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dirPath) => {
        await rm(dirPath, { force: true, recursive: true });
      }),
    );
    tempDirs.length = 0;
  });

  it('rewrites packaged app.asar paths to app.asar.unpacked when needed', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'frame-view-binary-'));
    tempDirs.push(tempRoot);

    const unpackedBinaryPath = path.join(
      tempRoot,
      'app.asar.unpacked',
      'node_modules',
      'ffmpeg-static',
      'ffmpeg.exe',
    );
    await mkdir(path.dirname(unpackedBinaryPath), { recursive: true });
    await writeFile(unpackedBinaryPath, 'ffmpeg');

    const result = resolveBinaryPath(
      path.join(tempRoot, 'app.asar', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    );

    expect(result.exists).toBe(true);
    expect(result.resolvedPath).toBe(unpackedBinaryPath);
  });

  it('reports checked paths when the binary does not exist', () => {
    const result = resolveBinaryPath('C:\\missing\\ffmpeg.exe');

    expect(result.exists).toBe(false);
    expect(result.error).toContain('Checked:');
    expect(result.checkedPaths.length).toBeGreaterThan(0);
  });
});
