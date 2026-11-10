import {
  type FolderNode,
  type GallerySortMode,
  GallerySortModeSchema,
  type MediaItem,
  toArchivePath,
  trimTrailingSlash,
} from "@latch-works/media-domain";
import { z } from "zod";

/**
 * The gallery listing as the browser and the server functions share it: the
 * request schemas, the one normalization both sides apply, and the page,
 * entry, and snapshot shapes. Environment-neutral, so the client builds its
 * query keys from the same normalized request the server reads.
 */

const DEFAULT_GALLERY_LISTING_LIMIT = 60;

/** Most excluded child paths one listing request may carry; normalization trims to it. */
const EXCLUDED_PATHS_LIMIT = 200;

/** 32 lowercase hexadecimal characters: a random seed (16 bytes) or an md5 rank. */
const HEX_128_PATTERN = /^[0-9a-f]{32}$/u;

/**
 * The gallery random seed. It travels on every listing request and inside
 * every cursor, and the server derives one total order from it.
 */
export const GalleryRandomSeedSchema = z.string().regex(HEX_128_PATTERN);

export type GalleryRandomSeed = z.infer<typeof GalleryRandomSeedSchema>;

/** The rank a random-mode cursor carries (see galleryRandomOrderKey). */
export const GalleryRandomOrderKeySchema = z.string().regex(HEX_128_PATTERN);

/**
 * What one listing row stands for: one media item, keyed by entry id, or one
 * comic, keyed by its folder path.
 */
export type GallerySubjectKind = "media" | "comic";

/** One library media row as the gallery shows it. */
export type GalleryMedia = Pick<
  MediaItem,
  "extension" | "id" | "mediaType" | "mtimeMs" | "name" | "parentPath" | "path" | "size"
> & {
  /**
   * The content hash. A synced replacement keeps the entry id while the bytes
   * change, so delivery URL caches key on it as well as on the id.
   */
  sha256: string;
};

/**
 * One comic as listed: identity, display name, cover, and the eligible page
 * count under the current filters. Full pages load only when the reader opens
 * (getGalleryComic), so a listing page's size does not depend on how many
 * pages its comics have.
 */
interface GalleryComicSummary {
  cover: GalleryMedia;
  /** Equal to `id`, the canonical comic identity. */
  folderPath: string;
  id: string;
  name: string;
  pageCount: number;
}

/** One complete comic for the reader: every eligible page in natural order. */
export interface GalleryComic {
  cover: GalleryMedia;
  folderPath: string;
  id: string;
  name: string;
  pages: GalleryMedia[];
}

export type GalleryBrowseEntry =
  | { hasChildren: boolean; key: `folder:${string}`; kind: "folder"; name: string; path: string }
  | { key: `media:${string}`; kind: "media"; media: GalleryMedia }
  | { comic: GalleryComicSummary; key: `comic:${string}`; kind: "comic" };

/** The media a browse entry stands for in the media sequence, if any. */
export function entryMedia(entry: GalleryBrowseEntry): GalleryMedia | null {
  return entry.kind === "media" ? entry.media : entry.kind === "comic" ? entry.comic.cover : null;
}

/**
 * One page of the listing, in final display order: the server owns
 * presentation order; clients append pages and never sort them. Media mode
 * lists folder cards (first page, non-recursive only) then media; comic mode
 * lists comics.
 */
export interface GalleryListingPage {
  entries: GalleryBrowseEntry[];
  page: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
  };
  subjectKind: GallerySubjectKind;
}

/** "" is the archive root. */
export function normalizeArchivePath(path: string | undefined): string {
  return trimTrailingSlash(toArchivePath(path ?? ""));
}

/** A search query: trimmed, and absent when empty. */
function normalizeQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();

  return trimmed ? trimmed : undefined;
}

export const GalleryListingRequestSchema = z.object({
  comicMode: z.boolean().optional(),
  cursor: z.string().optional(),
  /** Direct-child subtrees excluded from recursive and comic aggregation (Plan 054). */
  excludedPaths: z.array(z.string()).max(EXCLUDED_PATHS_LIMIT).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  path: z.string().optional(),
  query: z.string().optional(),
  randomSeed: GalleryRandomSeedSchema,
  recursive: z.boolean().optional(),
  showImages: z.boolean(),
  showVideos: z.boolean(),
  sortMode: GallerySortModeSchema,
});

export interface GalleryListingRequest {
  comicMode: boolean;
  excludedPaths: string[];
  limit: number;
  path: string;
  query: string | undefined;
  randomSeed: GalleryRandomSeed;
  recursive: boolean;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}

/**
 * The listing request's one normalization, applied by the client before it
 * keys a query and by the server function before it reads: paths normalized,
 * the query trimmed, comic mode implies recursive, and excludes ride along
 * only while recursive (Plan 054, Decision 3), trimmed to the cap so an
 * oversized stored list degrades to a partial exclude instead of a rejected
 * request. The conditions own which excludes apply (direct children only).
 */
export function normalizeListingRequest(
  input: Omit<z.input<typeof GalleryListingRequestSchema>, "cursor">,
): GalleryListingRequest {
  const comicMode = input.comicMode ?? false;
  const recursive = (input.recursive ?? false) || comicMode;

  return {
    comicMode,
    excludedPaths: recursive
      ? (input.excludedPaths ?? []).slice(0, EXCLUDED_PATHS_LIMIT).map(normalizeArchivePath)
      : [],
    limit: input.limit ?? DEFAULT_GALLERY_LISTING_LIMIT,
    path: normalizeArchivePath(input.path),
    query: normalizeQuery(input.query),
    randomSeed: input.randomSeed,
    recursive,
    showImages: input.showImages,
    showVideos: input.showVideos,
    sortMode: input.sortMode,
  };
}

export const GalleryComicRequestSchema = z.object({
  comicId: z.string().min(1),
  path: z.string().optional(),
  query: z.string().optional(),
  showImages: z.boolean().optional(),
  showVideos: z.boolean().optional(),
});

export interface GalleryComicRequest {
  comicId: string;
  path: string;
  query: string | undefined;
  showImages: boolean;
  showVideos: boolean;
}

export function normalizeComicRequest(
  input: z.input<typeof GalleryComicRequestSchema>,
): GalleryComicRequest {
  return {
    comicId: normalizeArchivePath(input.comicId),
    path: normalizeArchivePath(input.path),
    query: normalizeQuery(input.query),
    showImages: input.showImages ?? true,
    showVideos: input.showVideos ?? true,
  };
}

/** The comic `comicId` as the listing `listing` shows it: the same folder, search and filters. */
export function comicRequestFor(
  comicId: string,
  listing: GalleryListingRequest,
): GalleryComicRequest {
  return normalizeComicRequest({
    comicId,
    path: listing.path,
    query: listing.query,
    showImages: listing.showImages,
    showVideos: listing.showVideos,
  });
}

export const LibrarySnapshotRequestSchema = z.object({
  includeAllFolders: z.boolean().optional(),
  path: z.string().optional(),
  query: z.string().optional(),
});

export interface LibrarySnapshotRequest {
  includeAllFolders: boolean;
  path: string;
  query: string | undefined;
}

export function normalizeSnapshotRequest(
  input: z.input<typeof LibrarySnapshotRequestSchema>,
): LibrarySnapshotRequest {
  return {
    includeAllFolders: input.includeAllFolders ?? false,
    path: normalizeArchivePath(input.path),
    query: normalizeQuery(input.query),
  };
}

/**
 * The sidebar, the exclude dialog, and sibling navigation never show whether
 * a folder has children, so the snapshot skips that lookup.
 */
export type SnapshotFolder = Omit<FolderNode, "hasChildren">;

export interface LibrarySnapshot {
  /** Every live folder, with `includeAllFolders`; empty otherwise. */
  allFolders: FolderNode[];
  currentPath: string;
  /** Child folders of `currentPath`, or name matches while searching. */
  folders: SnapshotFolder[];
  /** Folders sharing `currentPath`'s parent, itself included; empty at the root. Unordered. */
  siblings: SnapshotFolder[];
}
