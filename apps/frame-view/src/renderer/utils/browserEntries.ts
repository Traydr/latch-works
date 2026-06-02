import type { FolderNode, GallerySortMode, MediaItem } from '../../shared/types';
import type { ComicEntry } from './comics';

export type BrowserEntry =
  | {
      key: string;
      kind: 'folder';
      path: string;
      name: string;
      hasChildren: boolean;
    }
  | {
      comic: ComicEntry;
      key: string;
      kind: 'comic';
    }
  | {
      key: string;
      kind: 'media';
      media: MediaItem;
      mediaIndex: number;
    };

function sortFolders(folders: FolderNode[], sortMode: GallerySortMode): FolderNode[] {
  const sorted = [...folders].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true }),
  );

  if (sortMode === 'name-desc') {
    sorted.reverse();
  }

  return sorted;
}

export class BrowserEntryCollection {
  private readonly folderEntries: BrowserEntry[];
  private readonly comicEntries: BrowserEntry[];
  private readonly mediaChunks: MediaItem[][];
  private readonly mediaChunkOffsets: number[];
  private readonly mediaIndexById: Map<string, number>;
  private readonly mediaEntryCountValue: number;

  constructor(
    folderEntries: BrowserEntry[],
    comicEntries: BrowserEntry[],
    mediaChunks: MediaItem[][],
  ) {
    this.folderEntries = folderEntries;
    this.comicEntries = comicEntries;
    this.mediaChunks = mediaChunks;
    this.mediaChunkOffsets = [];
    this.mediaIndexById = new Map<string, number>();

    let runningOffset = 0;
    for (const chunk of mediaChunks) {
      this.mediaChunkOffsets.push(runningOffset);

      for (let itemIndex = 0; itemIndex < chunk.length; itemIndex += 1) {
        const item = chunk[itemIndex];
        if (!item) {
          continue;
        }

        this.mediaIndexById.set(
          item.id,
          this.folderEntries.length + this.comicEntries.length + runningOffset + itemIndex,
        );
      }

      runningOffset += chunk.length;
    }

    this.mediaEntryCountValue = runningOffset;
  }

  get length(): number {
    return this.folderEntries.length + this.comicEntries.length + this.mediaEntryCountValue;
  }

  get folderEntryCount(): number {
    return this.folderEntries.length;
  }

  get comicEntryCount(): number {
    return this.comicEntries.length;
  }

  get mediaEntryCount(): number {
    return this.mediaEntryCountValue;
  }

  at(index: number): BrowserEntry | null {
    if (index < 0 || index >= this.length) {
      return null;
    }

    if (index < this.folderEntries.length) {
      return this.folderEntries[index] ?? null;
    }

    const comicIndex = index - this.folderEntries.length;
    if (comicIndex < this.comicEntries.length) {
      return this.comicEntries[comicIndex] ?? null;
    }

    const relativeMediaIndex = index - this.folderEntries.length - this.comicEntries.length;

    for (let chunkIndex = this.mediaChunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
      const chunkOffset = this.mediaChunkOffsets[chunkIndex] ?? 0;
      if (relativeMediaIndex < chunkOffset) {
        continue;
      }

      const chunk = this.mediaChunks[chunkIndex];
      if (!chunk) {
        continue;
      }

      const itemIndex = relativeMediaIndex - chunkOffset;
      const media = chunk[itemIndex];
      if (!media) {
        return null;
      }

      return {
        key: `media:${media.id}`,
        kind: 'media',
        media,
        mediaIndex: chunkOffset + itemIndex,
      };
    }

    return null;
  }

  findIndexByKey(key: string): number {
    if (key.startsWith('folder:')) {
      return this.folderEntries.findIndex((entry) => entry.key === key);
    }

    if (key.startsWith('comic:')) {
      const comicIndex = this.comicEntries.findIndex((entry) => entry.key === key);
      return comicIndex < 0 ? -1 : this.folderEntries.length + comicIndex;
    }

    if (!key.startsWith('media:')) {
      return -1;
    }

    const itemId = key.slice('media:'.length);
    return this.mediaIndexById.get(itemId) ?? -1;
  }

  firstKey(): string | null {
    return this.at(0)?.key ?? null;
  }
}

export function buildBrowserEntryCollection(
  folders: FolderNode[],
  comics: ComicEntry[],
  items: MediaItem[],
  loadingChunks: MediaItem[][],
  recursive: boolean,
  comicMode: boolean,
  sortMode: GallerySortMode,
  isLoading: boolean,
): BrowserEntryCollection {
  const folderEntries: BrowserEntry[] = recursive
    ? []
    : sortFolders(folders, sortMode).map((folder) => ({
        key: `folder:${folder.path}`,
        kind: 'folder',
        path: folder.path,
        name: folder.name,
        hasChildren: folder.hasChildren,
      }));

  const comicEntries: BrowserEntry[] =
    comicMode && !isLoading
      ? comics.map((comic) => ({
          key: `comic:${comic.id}`,
          kind: 'comic',
          comic,
        }))
      : [];

  const mediaChunks = comicMode ? [] : isLoading ? loadingChunks : items.length > 0 ? [items] : [];
  return new BrowserEntryCollection(folderEntries, comicEntries, mediaChunks);
}

export function getMediaEntryKey(itemId: string): string {
  return `media:${itemId}`;
}
