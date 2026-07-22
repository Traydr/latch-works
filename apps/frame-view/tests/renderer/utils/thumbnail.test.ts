import { describe, expect, it } from 'vitest';

import { getThumbnailPriorityForRow } from '../../../src/renderer/utils/thumbnail';

describe('thumbnail renderer helpers', () => {
  it('assigns higher priority to visible rows than overscan rows', () => {
    const viewport = { start: 4, end: 8 };
    const overscan = { start: 1, end: 11 };

    expect(getThumbnailPriorityForRow(5, viewport, overscan)).toBe(2);
    expect(getThumbnailPriorityForRow(2, viewport, overscan)).toBe(1);
    expect(getThumbnailPriorityForRow(15, viewport, overscan)).toBe(0);
  });
});
