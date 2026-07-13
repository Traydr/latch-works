import type { FolderNode, GallerySortMode } from "@latch-works/media-domain";
import {
  GallerySortModeSchema,
  getParentPath,
  toArchivePath,
  trimTrailingSlash,
} from "@latch-works/media-domain";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { GalleryListingPage } from "../../server/library/gallery-listing";
import { DEFAULT_GALLERY_LISTING_LIMIT } from "../../server/library/gallery-listing";
import type { LibraryMediaItem, MediaPage } from "../../server/library/types";

const fixtureRoots = ["nsfw", "nsfw-stories", "sfw", "sfw/patreon"];
export const DEFAULT_MEDIA_PAGE_LIMIT = 500;
const SEARCH_RESULT_LIMIT = 200;

const libraryRequestSchema = z.object({
  comicMode: z.boolean().optional(),
  includeAllFolders: z.boolean().optional(),
  mediaLimit: z.number().int().min(0).max(5000).optional(),
  mediaOffset: z.number().int().min(0).optional(),
  path: z.string().optional(),
  query: z.string().optional(),
  recursive: z.boolean().optional(),
  searchOffset: z.number().int().min(0).optional(),
});

const galleryListingRequestSchema = z.object({
  comicMode: z.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  path: z.string().optional(),
  query: z.string().optional(),
  randomSeed: z.number().int().nonnegative(),
  recursive: z.boolean().optional(),
  showImages: z.boolean(),
  showVideos: z.boolean(),
  sortMode: GallerySortModeSchema,
});

export interface GalleryListingRequest {
  comicMode: boolean;
  cursor?: string;
  limit?: number;
  path: string | undefined;
  query: string | undefined;
  randomSeed: number;
  recursive: boolean;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}

export interface LibrarySnapshot {
  allFolders: FolderNode[];
  archiveRoot: string;
  currentPath: string;
  folders: FolderNode[];
  media: LibraryMediaItem[];
  mediaPage: MediaPage;
  mediaUrlMode: "signed-url";
  roots: string[];
}

const deleteLibraryEntrySchema = z.object({
  entryId: z.string().uuid(),
});

export const deleteLibraryEntry = createServerFn({ method: "POST" })
  .inputValidator(deleteLibraryEntrySchema)
  .handler(async ({ data }): Promise<{ deleted: boolean }> => {
    await assertWebSessionAuthorized();

    const { softDeleteLibraryEntry } = await import("../../server/library/repository");
    const deleted = await softDeleteLibraryEntry({ entryId: data.entryId });
    return { deleted };
  });

export async function assertWebSessionAuthorized(): Promise<void> {
  const { isCurrentWebSessionValid } = await import("../../server/auth/web-session");
  if (!(await isCurrentWebSessionValid())) {
    throw new Error("Unauthorized");
  }
}

export async function readLibrarySnapshotRequest(
  data: z.infer<typeof libraryRequestSchema>,
): Promise<LibrarySnapshot> {
  const currentPath = normalizeLibraryPath(data.path);
  const query = normalizeQuery(data.query);
  const comicMode = data.comicMode ?? false;
  const includeAllFolders = data.includeAllFolders ?? comicMode;
  const recursive = (data.recursive ?? false) || comicMode;
  const searchOffset = data.searchOffset ?? 0;
  const mediaOffset = query ? searchOffset : (data.mediaOffset ?? 0);
  const mediaLimit =
    data.mediaLimit !== undefined
      ? data.mediaLimit
      : query
        ? SEARCH_RESULT_LIMIT
        : DEFAULT_MEDIA_PAGE_LIMIT;
  const { readDatabaseLibrarySnapshot } = await import("../../server/library/repository");
  const databaseSnapshot = await readDatabaseLibrarySnapshot({
    currentPath,
    includeAllFolders,
    limit: mediaLimit,
    offset: mediaOffset,
    query,
    recursive,
  });

  return {
    allFolders: databaseSnapshot.allFolders,
    archiveRoot: "Synced archive",
    currentPath,
    folders: databaseSnapshot.folders,
    media: databaseSnapshot.media,
    mediaPage: databaseSnapshot.mediaPage,
    mediaUrlMode: "signed-url",
    roots: databaseSnapshot.roots.length ? databaseSnapshot.roots : readFixtureRoots(currentPath),
  };
}

export const getGalleryListing = createServerFn({ method: "GET" })
  .inputValidator(galleryListingRequestSchema)
  .handler(async ({ data }): Promise<GalleryListingPage> => {
    await assertWebSessionAuthorized();

    const currentPath = normalizeLibraryPath(data.path);
    const query = normalizeQuery(data.query);
    const comicMode = data.comicMode ?? false;
    const recursive = (data.recursive ?? false) || comicMode;

    if (comicMode) {
      throw new Error("Gallery listing is not available in comic mode");
    }

    const { readDatabaseGalleryListing } = await import("../../server/library/repository");
    return readDatabaseGalleryListing({
      currentPath,
      cursor: data.cursor,
      limit: data.limit ?? DEFAULT_GALLERY_LISTING_LIMIT,
      query,
      randomSeed: data.randomSeed,
      recursive,
      showImages: data.showImages,
      showVideos: data.showVideos,
      sortMode: data.sortMode,
    });
  });

export const getLibrarySnapshot = createServerFn({ method: "GET" })
  .inputValidator(libraryRequestSchema)
  .handler(async ({ data }): Promise<LibrarySnapshot> => {
    await assertWebSessionAuthorized();
    return readLibrarySnapshotRequest(data);
  });

function normalizeLibraryPath(path: string | undefined): string {
  return trimTrailingSlash(toArchivePath(path ?? ""));
}

function normalizeQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  return trimmed ? trimmed : undefined;
}

function readFixtureRoots(currentPath: string): string[] {
  return fixtureRoots
    .concat(currentPath, getParentPath(currentPath))
    .filter((path) => path.length > 0)
    .filter(dedupe);
}

function dedupe(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}
