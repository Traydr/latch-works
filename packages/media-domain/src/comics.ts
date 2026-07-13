import type { GallerySortMode, MediaItem } from "./media.js";
import { displayNameFromPath, getParentPath, normalizePathForCompare } from "./paths.js";
import { compareByName, sortMediaItems, type SortableMediaItem } from "./sort.js";

export interface ComicMediaItem extends SortableMediaItem {
  id: string;
  mediaType: string;
}

export interface ComicEntry<T extends ComicMediaItem = MediaItem> {
  cover: T;
  folderPath: string;
  id: string;
  name: string;
  pages: T[];
}

export interface ComicPathAdapter {
  displayNameFromPath(path: string): string;
  getParentPath(path: string): string;
  normalizePathForCompare(path: string): string;
}

const archiveComicPathAdapter: ComicPathAdapter = {
  displayNameFromPath,
  getParentPath,
  normalizePathForCompare,
};

export interface BuildComicEntriesOptions {
  /** Skip folders that contain child folders; only leaf folders become comics. */
  leafFoldersOnly?: boolean;
  folders?: readonly { parentPath: string }[];
  /** Archive paths are the default; absolute OS paths must supply an adapter. */
  pathAdapter?: ComicPathAdapter;
}

export function buildComicEntries<T extends ComicMediaItem>(
  items: readonly T[],
  rootPath: string | null = null,
  options: BuildComicEntriesOptions = {},
): ComicEntry<T>[] {
  const pathAdapter = options.pathAdapter ?? archiveComicPathAdapter;
  const pagesByFolder = new Map<string, T[]>();
  const normalizedRootPath = rootPath ? pathAdapter.normalizePathForCompare(rootPath) : null;
  const pathsWithChildFolders =
    options.leafFoldersOnly && options.folders
      ? new Set(
          options.folders
            .map((folder) => folder.parentPath)
            .filter((parentPath): parentPath is string => Boolean(parentPath)),
        )
      : null;

  for (const item of items) {
    if (item.mediaType !== "image" && item.mediaType !== "gif") {
      continue;
    }

    const folderPath = pathAdapter.getParentPath(item.path);
    if (!folderPath) {
      continue;
    }

    if (normalizedRootPath && pathAdapter.normalizePathForCompare(folderPath) === normalizedRootPath) {
      continue;
    }

    const pages = pagesByFolder.get(folderPath) ?? [];
    pages.push(item);
    pagesByFolder.set(folderPath, pages);
  }

  const comics: ComicEntry<T>[] = [];
  for (const [folderPath, pages] of pagesByFolder) {
    if (pathsWithChildFolders?.has(folderPath)) {
      continue;
    }

    const sortedPages = [...pages].sort(compareByName);
    const cover = sortedPages[0];
    if (!cover) {
      continue;
    }

    comics.push({
      cover,
      folderPath,
      id: folderPath,
      name: pathAdapter.displayNameFromPath(folderPath),
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

export function sortComicEntries<T extends ComicMediaItem>(
  comics: readonly ComicEntry<T>[],
  sortMode: GallerySortMode,
  randomSeed: number,
): ComicEntry<T>[] {
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
