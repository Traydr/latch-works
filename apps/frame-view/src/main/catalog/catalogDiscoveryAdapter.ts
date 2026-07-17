import { getExtension, isSystemJunkDirectory, isSystemJunkFile } from '@latch-works/media-domain';

import type { MediaItem } from '../../shared/types';

/**
 * Frame catalog discovery adapter.
 *
 * Classification uses the same media-domain primitives as `@latch-works/media-index`
 * (`getExtension`, system-junk skips). CatalogRuntime still owns Frame-only concerns:
 * streaming batch emission, cancel/progress, absolute-path MediaItem identity,
 * optional `thumbnailPath`, recursive/non-recursive roots, excluded root children,
 * and SQLite persistence via MediaIndexService.
 *
 * Full `scanArchive` adoption remains deferred — media-index returns a complete
 * archive-relative result and always recurses, which does not yet replace Frame's
 * incremental Electron catalog worker.
 */

export interface FrameScanFilters {
  imageExtensions: Set<string>;
  showImages: boolean;
  showVideos: boolean;
  videoExtensions: Set<string>;
}

export interface FrameScanCandidate {
  extension: string;
  fullPath: string;
  mediaType: 'image' | 'video';
  name: string;
}

export function shouldSkipDirectoryName(directoryName: string): boolean {
  return isSystemJunkDirectory(directoryName);
}

export function classifyFrameCandidate(
  name: string,
  filters: FrameScanFilters,
): Omit<FrameScanCandidate, 'fullPath'> | null {
  if (isSystemJunkFile(name)) {
    return null;
  }

  const extension = getExtension(name);
  const isImage = filters.showImages && filters.imageExtensions.has(extension);
  const isVideo = filters.showVideos && filters.videoExtensions.has(extension);
  if (!isImage && !isVideo) {
    return null;
  }

  return {
    extension,
    mediaType: isVideo ? 'video' : 'image',
    name,
  };
}

export function toFrameMediaItem(
  candidate: FrameScanCandidate,
  stats: { mtimeMs: number; size: number },
): MediaItem {
  return {
    id: `${candidate.fullPath}:${stats.size}:${stats.mtimeMs}`,
    path: candidate.fullPath,
    name: candidate.name,
    extension: candidate.extension,
    mediaType: candidate.mediaType,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}
