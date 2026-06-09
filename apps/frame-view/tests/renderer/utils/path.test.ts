import { describe, expect, it } from 'vitest';

import { getParentPath, toDisplayName } from '../../../src/renderer/utils/path';

describe('getParentPath', () => {
  it('returns null for empty input', () => {
    expect(getParentPath(null)).toBeNull();
  });

  it('preserves POSIX separators on macOS-style paths', () => {
    expect(getParentPath('/Users/album/2024')).toBe('/Users/album');
    expect(getParentPath('/Users/album/')).toBe('/Users');
  });

  it('returns root parent for single-segment POSIX paths under root', () => {
    expect(getParentPath('/Users')).toBe('/');
  });

  it('returns null at filesystem root', () => {
    expect(getParentPath('/')).toBeNull();
  });

  it('uses backslashes for Windows-style paths', () => {
    expect(getParentPath('C:\\gallery\\nested')).toBe('C:\\gallery');
    expect(getParentPath('C:/gallery/nested')).toBe('C:\\gallery');
  });

  it('returns drive root with trailing backslash', () => {
    expect(getParentPath('C:\\gallery')).toBe('C:\\');
  });

  it('returns null at drive letter root', () => {
    expect(getParentPath('C:\\')).toBeNull();
    expect(getParentPath('C:')).toBeNull();
  });
});

describe('toDisplayName', () => {
  it('returns the last path segment', () => {
    expect(toDisplayName('/Users/album/2024')).toBe('2024');
    expect(toDisplayName('C:\\gallery\\nested')).toBe('nested');
  });

  it('returns a placeholder when no folder is selected', () => {
    expect(toDisplayName(null)).toBe('No folder selected');
  });
});
