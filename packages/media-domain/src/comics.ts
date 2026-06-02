import type { GallerySortMode, MediaItem } from "./media.js";
import { displayNameFromPath, getParentPath, normalizePathForCompare } from "./paths.js";
import { compareByName, sortMediaItems } from "./sort.js";

export interface ComicEntry {
  cover: MediaItem;
  folderPath: string;
  id: string;
  name: string;
  pages: MediaItem[];
}

export function buildComicEntries(
  items: readonly MediaItem[],
  rootPath: string | null = null,
): ComicEntry[] {
  const pagesByFolder = new Map<string, MediaItem[]>();
  const normalizedRootPath = rootPath ? normalizePathForCompare(rootPath) : null;

  for (const item of items) {
    if (item.mediaType !== "image") {
      continue;
    }

    const folderPath = getParentPath(item.path);
    if (!folderPath) {
      continue;
    }

    if (normalizedRootPath && normalizePathForCompare(folderPath) === normalizedRootPath) {
      continue;
    }

    const pages = pagesByFolder.get(folderPath) ?? [];
    pages.push(item);
    pagesByFolder.set(folderPath, pages);
  }

  const comics: ComicEntry[] = [];
  for (const [folderPath, pages] of pagesByFolder) {
    const sortedPages = [...pages].sort(compareByName);
    const cover = sortedPages[0];
    if (!cover) {
      continue;
    }

    comics.push({
      cover,
      folderPath,
      id: folderPath,
      name: displayNameFromPath(folderPath),
      pages: sortedPages,
    });
  }

  return comics.sort((left, right) =>
    compareByName(
      { name: left.name, path: left.folderPath },
      { name: right.name, path: right.folderPath },
    ),
  );
}

export function sortComicEntries(
  comics: readonly ComicEntry[],
  sortMode: GallerySortMode,
  randomSeed: number,
): ComicEntry[] {
  const comicByCoverId = new Map(comics.map((comic) => [comic.cover.id, comic]));
  return sortMediaItems(
    comics.map((comic) => comic.cover),
    sortMode,
    randomSeed,
  ).flatMap((cover) => {
    const comic = comicByCoverId.get(cover.id);
    return comic ? [comic] : [];
  });
}
