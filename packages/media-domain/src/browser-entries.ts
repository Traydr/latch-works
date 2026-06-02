import type { ComicEntry } from "./comics.js";
import type { FolderNode, GallerySortMode, MediaItem } from "./media.js";

export type BrowserEntry =
  | {
      key: string;
      kind: "folder";
      path: string;
      name: string;
      hasChildren: boolean;
    }
  | {
      comic: ComicEntry;
      key: string;
      kind: "comic";
    }
  | {
      key: string;
      kind: "media";
      media: MediaItem;
      mediaIndex: number;
    };

function sortFolders(folders: readonly FolderNode[], sortMode: GallerySortMode): FolderNode[] {
  const sorted = [...folders].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }),
  );

  if (sortMode === "name-desc") {
    sorted.reverse();
  }

  return sorted;
}

export function buildBrowserEntries({
  folders,
  comics,
  items,
  recursive,
  comicMode,
  sortMode,
}: {
  folders: readonly FolderNode[];
  comics: readonly ComicEntry[];
  items: readonly MediaItem[];
  recursive: boolean;
  comicMode: boolean;
  sortMode: GallerySortMode;
}): BrowserEntry[] {
  const folderEntries: BrowserEntry[] = recursive
    ? []
    : sortFolders(folders, sortMode).map((folder) => ({
        key: `folder:${folder.path}`,
        kind: "folder",
        path: folder.path,
        name: folder.name,
        hasChildren: folder.hasChildren,
      }));

  const comicEntries: BrowserEntry[] = comicMode
    ? comics.map((comic) => ({
        key: `comic:${comic.id}`,
        kind: "comic",
        comic,
      }))
    : [];

  const mediaEntries: BrowserEntry[] = comicMode
    ? []
    : items.map((media, mediaIndex) => ({
        key: `media:${media.id}`,
        kind: "media",
        media,
        mediaIndex,
      }));

  return [...folderEntries, ...comicEntries, ...mediaEntries];
}
