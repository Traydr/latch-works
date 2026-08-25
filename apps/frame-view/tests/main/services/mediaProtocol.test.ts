import { describe, expect, it } from 'vitest';

import {
  authorizeMediaRoot,
  isAuthorizedMediaPath,
  isPathWithinRoot,
  shrinkAuthorizedMediaRootsTo,
} from '../../../src/main/services/mediaProtocol';

describe('mediaProtocol helpers', () => {
  it('checks whether a path is inside an authorized root', () => {
    if (process.platform === 'win32') {
      expect(isPathWithinRoot('C:\\gallery\\nested\\image.jpg', 'C:\\gallery')).toBe(true);
      expect(isPathWithinRoot('C:\\gallery-other\\image.jpg', 'C:\\gallery')).toBe(false);
      return;
    }

    expect(isPathWithinRoot('/tmp/gallery/nested/image.jpg', '/tmp/gallery')).toBe(true);
    expect(isPathWithinRoot('/tmp/gallery-other/image.jpg', '/tmp/gallery')).toBe(false);
  });

  it('treats paths as case-insensitive on darwin and win32', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return;
    }

    if (process.platform === 'win32') {
      expect(isPathWithinRoot('C:\\Gallery\\Nested\\image.jpg', 'C:\\gallery')).toBe(true);
      return;
    }

    expect(isPathWithinRoot('/tmp/Gallery/Nested/image.jpg', '/tmp/gallery')).toBe(true);
  });

  it('shrinks authorized roots to the most specific matching root', async () => {
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

});
