import {
  buildComicEntries as buildSharedComicEntries,
  type ComicPathAdapter,
  type ComicEntry as SharedComicEntry,
  sortComicEntries as sortSharedComicEntries,
} from '@latch-works/media-domain';
import type { GallerySortMode, MediaItem } from '../../shared/types';

export type ComicEntry = SharedComicEntry<MediaItem>;

const absolutePathComicAdapter: ComicPathAdapter = {
  displayNameFromPath(folderPath) {
    const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const separatorIndex = normalized.lastIndexOf('/');
    return (separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized).replace(
      /[_-]/g,
      ' ',
    );
  },
  getParentPath(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const separatorIndex = normalized.lastIndexOf('/');
    return separatorIndex <= 0 ? '' : filePath.slice(0, separatorIndex);
  },
  normalizePathForCompare(folderPath) {
    return folderPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  },
};

export const buildComicEntries = (
  items: MediaItem[],
  rootPath: string | null = null,
): ComicEntry[] =>
  buildSharedComicEntries(items, rootPath, { pathAdapter: absolutePathComicAdapter });

export function sortComicEntries(
  comics: ComicEntry[],
  sortMode: GallerySortMode,
  randomSeed: number,
): ComicEntry[] {
  return sortSharedComicEntries(comics, sortMode, randomSeed);
}
