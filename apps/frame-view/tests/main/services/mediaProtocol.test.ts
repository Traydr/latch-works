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

    expect(isPathWithinRoot('C:\\gallery\\nested\\image.jpg', 'C:\\gallery')).toBe(true);
    expect(isPathWithinRoot('C:\\gallery-other\\image.jpg', 'C:\\gallery')).toBe(false);
  });

  it('clamps thumbnail priority hints', async () => {
    const { parseThumbnailPriority } = await import('../../../src/main/services/mediaProtocol');

    expect(parseThumbnailPriority('2')).toBe(2);
    expect(parseThumbnailPriority('1')).toBe(1);
    expect(parseThumbnailPriority('-4')).toBe(0);
    expect(parseThumbnailPriority('100')).toBe(2);
    expect(parseThumbnailPriority('wat')).toBe(0);
  });
});
