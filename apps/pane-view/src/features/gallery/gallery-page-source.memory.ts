import type { ComicEntry } from "@latch-works/media-domain";
import type {
  GalleryComicRequest,
  GalleryPageSource,
} from "@/features/gallery/gallery-page-source";
import type { GalleryListingQueryRequest } from "@/features/library/library-queries";
import type { LibraryMediaItem } from "@/features/library/types";
import type { GalleryComicSummary } from "../../server/library/gallery-listing";

/**
 * Test double for GalleryPageSource: pages are scripted per browse request,
 * every call is counted, and calls can be held open (deferred) so tests can
 * observe in-flight behaviour. Not used in production.
 */

export interface ScriptedListing {
  /** The full result in server order; the adapter slices it into pages of `limit`. */
  comics?: GalleryComicSummary[];
  media?: LibraryMediaItem[];
  /** Folder entries returned on the first page only (non-recursive media mode). */
  folders?: { hasChildren: boolean; name: string; path: string }[];
}

export interface MemoryGalleryPageSource extends GalleryPageSource {
  calls: { comic: GalleryComicRequest[]; page: GalleryListingQueryRequest[] };
  /** Replace the scripted listing for a request key; the next load reads the new population. */
  script(key: string, listing: ScriptedListing): void;
  /** Hold every subsequent call until `release()`; returns the number of held calls on release. */
  hold(): void;
  release(): Promise<void>;
  /** Make the next `loadPage` reject once. */
  failNextPage(error?: Error): void;
  /** Make the next `loadPage` return a page whose cursor equals the requesting cursor. */
  stallNextCursor(): void;
  comics: Map<string, ComicEntry<LibraryMediaItem>>;
}

/** The browse-population key: everything but the cursor. */
export function memorySourceKey(request: GalleryListingQueryRequest): string {
  return [
    request.path ?? "",
    request.query ?? "",
    request.recursive,
    request.comicMode,
    request.sortMode,
    request.randomSeed,
    request.showImages,
    request.showVideos,
  ].join("|");
}

function encodeCursor(offset: number, key: string): string {
  return `${key}#${offset}`;
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(cursor.slice(cursor.lastIndexOf("#") + 1));
  return Number.isFinite(offset) ? offset : 0;
}

export function createMemoryGalleryPageSource(
  scripts: Record<string, ScriptedListing> = {},
): MemoryGalleryPageSource {
  const listings = new Map(Object.entries(scripts));
  const held: Array<() => void> = [];
  let holding = false;
  let failNext: Error | null = null;
  let stallNext = false;

  const gate = (): Promise<void> =>
    holding ? new Promise<void>((resolve) => held.push(resolve)) : Promise.resolve();

  const source: MemoryGalleryPageSource = {
    calls: { comic: [], page: [] },
    comics: new Map(),
    failNextPage(error = new Error("scripted failure")) {
      failNext = error;
    },
    hold() {
      holding = true;
    },
    async loadComic(request) {
      source.calls.comic.push(request);
      await gate();
      const comic = source.comics.get(request.comicId);
      if (!comic) throw new Error(`No scripted comic ${request.comicId}`);
      return comic;
    },
    async loadPage(request) {
      source.calls.page.push(request);
      await gate();
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      const key = memorySourceKey(request);
      const listing = listings.get(key) ?? {};
      const limit = request.limit ?? 60;
      const offset = decodeCursor(request.cursor);
      const media = listing.media ?? [];
      const comics = listing.comics ?? [];
      const subjects = request.comicMode ? comics.length : media.length;
      const end = Math.min(offset + limit, subjects);
      const hasMore = end < subjects;
      const cursor = hasMore
        ? stallNext && request.cursor
          ? request.cursor
          : encodeCursor(end, key)
        : null;
      stallNext = false;

      if (request.comicMode) {
        const pageComics = comics.slice(offset, end);
        return {
          comics: pageComics,
          entries: [],
          media: pageComics.map((comic) => comic.cover),
          page: { cursor, hasMore, limit },
          subjectKind: "comic",
        };
      }

      const pageMedia = media.slice(offset, end);
      const folders =
        offset === 0 && !request.recursive
          ? (listing.folders ?? []).map((folder) => ({
              hasChildren: folder.hasChildren,
              key: `folder:${folder.path}`,
              kind: "folder" as const,
              name: folder.name,
              path: folder.path,
            }))
          : [];
      return {
        comics: [],
        entries: [
          ...folders,
          ...pageMedia.map((item, index) => ({
            key: `media:${item.id}`,
            kind: "media" as const,
            media: item,
            mediaIndex: offset + index,
          })),
        ],
        media: pageMedia,
        page: { cursor, hasMore, limit },
        subjectKind: "media",
      };
    },
    async release() {
      holding = false;
      const pending = held.splice(0);
      for (const resolve of pending) resolve();
      // Let the released promises settle before returning to the test.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    script(key, listing) {
      listings.set(key, listing);
    },
    stallNextCursor() {
      stallNext = true;
    },
  };
  return source;
}
