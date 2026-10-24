import type { ThumbnailJobPriority } from '../../shared/thumbnail';

export function getThumbnailRequestSize(thumbnailSize: number): number {
  return Math.round(thumbnailSize * 2);
}

export function getThumbnailPriorityForRow(
  row: number,
  viewportWindow: { start: number; end: number },
  overscanWindow: { start: number; end: number },
): ThumbnailJobPriority {
  if (row >= viewportWindow.start && row <= viewportWindow.end) {
    return 2;
  }

  if (row >= overscanWindow.start && row <= overscanWindow.end) {
    return 1;
  }

  return 0;
}
