import type { GallerySortMode, MediaItem } from '../../shared/types';
import { sortMediaItems } from './sort';

export interface ComicEntry {
  cover: MediaItem;
  folderPath: string;
  id: string;
  name: string;
  pages: MediaItem[];
}

const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function getParentPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex <= 0) {
    return '';
  }

  return filePath.slice(0, separatorIndex);
}

function getBaseName(folderPath: string): string {
  const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const separatorIndex = normalized.lastIndexOf('/');
  const baseName = separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
  return baseName.replace(/[_-]/g, ' ');
}

function normalizeFolderPath(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function comparePages(left: MediaItem, right: MediaItem): number {
  const byName = nameCollator.compare(left.name, right.name);
  if (byName !== 0) {
    return byName;
  }

  return nameCollator.compare(left.path, right.path);
}

export function buildComicEntries(
  items: MediaItem[],
  rootPath: string | null = null,
): ComicEntry[] {
  const pagesByFolder = new Map<string, MediaItem[]>();
  const normalizedRootPath = rootPath ? normalizeFolderPath(rootPath) : null;

  for (const item of items) {
    if (item.mediaType !== 'image') {
      continue;
    }

    const folderPath = getParentPath(item.path);
    if (!folderPath) {
      continue;
    }

    if (normalizedRootPath && normalizeFolderPath(folderPath) === normalizedRootPath) {
      continue;
    }

    const pages = pagesByFolder.get(folderPath) ?? [];
    pages.push(item);
    pagesByFolder.set(folderPath, pages);
  }

  const comics: ComicEntry[] = [];
  for (const [folderPath, pages] of pagesByFolder) {
    const sortedPages = [...pages].sort(comparePages);
    const cover = sortedPages[0];
    if (!cover) {
      continue;
    }

    comics.push({
      cover,
      folderPath,
      id: folderPath,
      name: getBaseName(folderPath),
      pages: sortedPages,
    });
  }

  return comics.sort((left, right) => {
    const byName = nameCollator.compare(left.name, right.name);
    if (byName !== 0) {
      return byName;
    }

    return nameCollator.compare(left.folderPath, right.folderPath);
  });
}

export function sortComicEntries(
  comics: ComicEntry[],
  sortMode: GallerySortMode,
  randomSeed: number,
): ComicEntry[] {
  const comicByCoverId = new Map(comics.map((comic) => [comic.cover.id, comic]));
  return sortMediaItems(
    comics.map((comic) => comic.cover),
    sortMode,
    randomSeed,
  )
    .map((cover) => comicByCoverId.get(cover.id))
    .filter((comic): comic is ComicEntry => comic !== undefined);
}
