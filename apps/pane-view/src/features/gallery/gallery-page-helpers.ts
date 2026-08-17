import type {
  BrowserEntry,
  FolderNode,
  GallerySortMode,
  MediaItem,
} from "@latch-works/media-domain";
import {
  buildBrowserEntries,
  buildComicEntries,
  sortComicEntries,
  sortMediaItems,
} from "@latch-works/media-domain";
import type { GalleryThumbnailRequest } from "@/features/gallery/batched-thumbnail-resolver";
import type { GalleryRandomSeed } from "@/features/gallery/gallery-random-seed";
import type { LibrarySnapshotRequest } from "@/features/library/library-queries";
import type { GalleryBrowsePage, LibraryMediaItem, MediaPage } from "@/features/library/types";

export function mergeLibraryMedia(
  base: readonly LibraryMediaItem[],
  extra: readonly LibraryMediaItem[],
): LibraryMediaItem[] {
  if (extra.length === 0) {
    return [...base];
  }

  const seen = new Set(base.map((item) => item.id));
  const merged = [...base];
  for (const item of extra) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }

  return merged;
}

export function toLibrarySnapshotNextPageRequest(
  request: LibrarySnapshotRequest,
  mediaOffset: number,
) {
  return {
    comicMode: request.comicMode,
    includeAllFolders: false,
    mediaOffset,
    path: request.path,
    query: request.query,
    recursive: request.recursive,
  };
}

export function supportsGalleryThumbnail(media: MediaItem): boolean {
  return (
    media.mediaType === "image" ||
    media.mediaType === "gif" ||
    media.mediaType === "video" ||
    media.mediaType === "pdf"
  );
}

export function dedupeThumbnailRequests(
  requests: readonly GalleryThumbnailRequest[],
): GalleryThumbnailRequest[] {
  const seen = new Set<string>();
  const deduped: GalleryThumbnailRequest[] = [];

  for (const request of requests) {
    const key = `${request.mediaId}:${request.size ?? "default"}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(request);
  }

  return deduped;
}

export function areThumbnailRequestsEqual(
  left: readonly GalleryThumbnailRequest[],
  right: readonly GalleryThumbnailRequest[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (request, index) =>
      request.mediaId === right[index]?.mediaId && request.size === right[index]?.size,
  );
}

/** Convert snapshot MediaPage into the unified browse page shape. */
export function browsePageFromMediaPage(mediaPage: MediaPage): GalleryBrowsePage {
  return {
    cursor: null,
    hasMore: mediaPage.hasMore,
    limit: mediaPage.limit,
    nextOffset: mediaPage.nextOffset,
  };
}

/** Convert listing cursor page into the unified browse page shape. */
export function browsePageFromListingPage(page: {
  cursor: string | null;
  hasMore: boolean;
  limit: number;
}): GalleryBrowsePage {
  return {
    cursor: page.cursor,
    hasMore: page.hasMore,
    limit: page.limit,
    nextOffset: null,
  };
}

/** MediaPage-shaped view for GalleryBrowsePane (only `hasMore` is required at call sites). */
export function mediaPageFromBrowsePage(page: GalleryBrowsePage | null): MediaPage | null {
  if (!page) {
    return null;
  }

  return {
    hasMore: page.hasMore,
    limit: page.limit,
    nextOffset: page.nextOffset,
    offset: 0,
  };
}

export function buildBrowseKey(parts: {
  comicMode: boolean;
  path: string | undefined;
  query: string | undefined;
  randomSeed?: GalleryRandomSeed;
  recursive: boolean;
  showImages?: boolean;
  showVideos?: boolean;
  sortMode?: GallerySortMode;
  /** When true, include listing-only sort/filter seed fields. */
  includeListingFields: boolean;
}): string {
  const base = [parts.path ?? "", parts.query ?? "", parts.recursive, parts.comicMode];
  if (!parts.includeListingFields) {
    return base.join("|");
  }

  return [
    ...base,
    parts.randomSeed ?? "",
    parts.showImages ?? true,
    parts.showVideos ?? true,
    parts.sortMode ?? "name-asc",
  ].join("|");
}

/**
 * Comic mode still sorts on the client with media-domain's numeric-seed sort
 * until Plan 052 moves it to the server listing. Fold the hex seed into the
 * 32-bit seed those helpers take.
 */
function legacyNumericSeed(seed: GalleryRandomSeed): number {
  return Number.parseInt(seed.slice(0, 8) || "0", 16) >>> 0;
}

export function filterMediaByVisibility(
  media: readonly LibraryMediaItem[],
  options: { showImages: boolean; showVideos: boolean },
): LibraryMediaItem[] {
  return media.filter((item) => {
    if (item.mediaType === "video" && !options.showVideos) {
      return false;
    }

    if ((item.mediaType === "image" || item.mediaType === "gif") && !options.showImages) {
      return false;
    }

    return true;
  });
}

/**
 * Resolve visible media for the unified browse model.
 * Listing mode trusts server sort/filter; comic mode sorts and filters client-side.
 */
export function resolveBrowseMedia(input: {
  comicMode: boolean;
  extraMedia: readonly LibraryMediaItem[];
  listingMedia: readonly LibraryMediaItem[] | undefined;
  randomSeed: GalleryRandomSeed;
  showImages: boolean;
  showVideos: boolean;
  snapshotMedia: readonly LibraryMediaItem[] | undefined;
  sortMode: GallerySortMode;
}): LibraryMediaItem[] {
  const base = input.comicMode ? (input.snapshotMedia ?? []) : (input.listingMedia ?? []);
  const merged = mergeLibraryMedia(base, input.extraMedia);

  if (!input.comicMode || merged.length === 0) {
    return merged;
  }

  const sorted = sortMediaItems(merged, input.sortMode, legacyNumericSeed(input.randomSeed));
  return filterMediaByVisibility(sorted, {
    showImages: input.showImages,
    showVideos: input.showVideos,
  });
}

/**
 * Resolve grid entries: listing appends server pages; comic post-processes media into entries.
 */
export function resolveBrowseEntries(input: {
  allFolders: readonly FolderNode[] | undefined;
  comicMode: boolean;
  displayPath: string;
  extraEntries: readonly BrowserEntry[];
  folders: readonly FolderNode[] | undefined;
  listingEntries: readonly BrowserEntry[] | undefined;
  randomSeed: GalleryRandomSeed;
  recursive: boolean;
  sortMode: GallerySortMode;
  visibleMedia: readonly LibraryMediaItem[];
}): BrowserEntry[] {
  if (!input.comicMode) {
    return [...(input.listingEntries ?? []), ...input.extraEntries];
  }

  if (!input.folders) {
    return [];
  }

  const groupedComics = buildComicEntries(input.visibleMedia, input.displayPath || null, {
    folders: input.allFolders ?? [],
    leafFoldersOnly: true,
  });
  const comics = sortComicEntries(
    groupedComics,
    input.sortMode,
    legacyNumericSeed(input.randomSeed),
  );

  return buildBrowserEntries({
    folders: input.folders,
    comics,
    items: input.visibleMedia,
    recursive: input.recursive,
    comicMode: true,
    sortMode: input.sortMode,
  });
}
