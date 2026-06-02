import { describe, expect, it } from 'vitest';

import {
  getThumbnailPriorityForRow,
  getThumbnailRequestSize,
} from '../../../src/renderer/utils/thumbnail';

describe('thumbnail renderer helpers', () => {
  it('uses the legacy 2x thumbnail request size', () => {
    expect(getThumbnailRequestSize(220)).toBe(440);
    expect(getThumbnailRequestSize(180)).toBe(360);
  });

  it('assigns higher priority to visible rows than overscan rows', () => {
    const viewport = { start: 4, end: 8 };
    const overscan = { start: 1, end: 11 };

    expect(getThumbnailPriorityForRow(5, viewport, overscan)).toBe(2);
    expect(getThumbnailPriorityForRow(2, viewport, overscan)).toBe(1);
    expect(getThumbnailPriorityForRow(15, viewport, overscan)).toBe(0);
  });
});
