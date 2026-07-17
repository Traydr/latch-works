import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: {
    handle: vi.fn(),
  },
}));

describe('mediaProtocol helpers', () => {
  it('parses byte ranges correctly', async () => {
    const { readRange } = await import('../../../src/main/services/mediaProtocol');

    expect(readRange('bytes=10-19', 100)).toEqual({ ok: true, start: 10, end: 19 });
    expect(readRange('bytes=-20', 100)).toEqual({ ok: true, start: 80, end: 99 });
    expect(readRange('bytes=20-', 100)).toEqual({ ok: true, start: 20, end: 99 });
    expect(readRange('bytes=200-300', 100)).toEqual({ ok: false, reason: 'malformed' });
    expect(readRange(null, 100)).toEqual({ ok: false, reason: 'missing' });
  });

  it('checks whether a path is inside an authorized root', async () => {
    const { isPathWithinRoot } = await import('../../../src/main/services/mediaProtocol');

    if (process.platform === 'win32') {
      expect(isPathWithinRoot('C:\\gallery\\nested\\image.jpg', 'C:\\gallery')).toBe(true);
      expect(isPathWithinRoot('C:\\gallery-other\\image.jpg', 'C:\\gallery')).toBe(false);
      return;
    }

    expect(isPathWithinRoot('/tmp/gallery/nested/image.jpg', '/tmp/gallery')).toBe(true);
    expect(isPathWithinRoot('/tmp/gallery-other/image.jpg', '/tmp/gallery')).toBe(false);
  });

  it('treats paths as case-insensitive on darwin and win32', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return;
    }

    const { isPathWithinRoot } = await import('../../../src/main/services/mediaProtocol');

    if (process.platform === 'win32') {
      expect(isPathWithinRoot('C:\\Gallery\\Nested\\image.jpg', 'C:\\gallery')).toBe(true);
      return;
    }

    expect(isPathWithinRoot('/tmp/Gallery/Nested/image.jpg', '/tmp/gallery')).toBe(true);
  });

  it('clamps thumbnail priority hints', async () => {
    const { parseThumbnailPriority } = await import('../../../src/main/services/mediaProtocol');

    expect(parseThumbnailPriority('2')).toBe(2);
    expect(parseThumbnailPriority('1')).toBe(1);
    expect(parseThumbnailPriority('-4')).toBe(0);
    expect(parseThumbnailPriority('100')).toBe(2);
    expect(parseThumbnailPriority('wat')).toBe(0);
  });

  it('shrinks authorized roots to the most specific matching root', async () => {
    const { authorizeMediaRoot, isAuthorizedMediaPath, shrinkAuthorizedMediaRootsTo } =
      await import('../../../src/main/services/mediaProtocol');

    const rootA = process.platform === 'win32' ? 'C:\\gallery-a' : '/tmp/gallery-a';
    const rootB = process.platform === 'win32' ? 'C:\\gallery-b' : '/tmp/gallery-b';
    const nested = process.platform === 'win32' ? 'C:\\gallery-a\\nested' : '/tmp/gallery-a/nested';

    await authorizeMediaRoot(rootA);
    await authorizeMediaRoot(rootB);
    expect(await isAuthorizedMediaPath(nested)).toBe(true);
    expect(await isAuthorizedMediaPath(rootB)).toBe(true);

    await shrinkAuthorizedMediaRootsTo(nested);
    expect(await isAuthorizedMediaPath(nested)).toBe(true);
    expect(await isAuthorizedMediaPath(rootB)).toBe(false);
  });

  it('authorizes the remembered last folder when rememberLastFolder is enabled', async () => {
    const {
      authorizeRememberedMediaRoot,
      isAuthorizedMediaPath,
    } = await import('../../../src/main/services/mediaProtocol');

    const remembered = process.platform === 'win32' ? 'C:\\remembered' : '/tmp/remembered';
    const nested =
      process.platform === 'win32' ? 'C:\\remembered\\album' : '/tmp/remembered/album';

    await authorizeRememberedMediaRoot({
      rememberLastFolder: true,
      lastFolderPath: remembered,
    });

    expect(await isAuthorizedMediaPath(remembered)).toBe(true);
    expect(await isAuthorizedMediaPath(nested)).toBe(true);
  });

  it('skips remembered-folder authorization when the setting is disabled', async () => {
    vi.resetModules();
    const {
      authorizeRememberedMediaRoot,
      isAuthorizedMediaPath,
    } = await import('../../../src/main/services/mediaProtocol');

    const remembered = process.platform === 'win32' ? 'C:\\skipped' : '/tmp/skipped';

    await authorizeRememberedMediaRoot({
      rememberLastFolder: false,
      lastFolderPath: remembered,
    });

    expect(await isAuthorizedMediaPath(remembered)).toBe(false);
  });
});
