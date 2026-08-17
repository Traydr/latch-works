import type { LibraryMediaItem } from "@/features/library/types";
import type { GalleryComicSummary, GalleryListingPage } from "../../server/library/gallery-listing";

/**
 * Pane View's own grid entry (Plan 052). media-domain's BrowserEntry (comic
 * with a full ComicEntry) stays for Frame View; the gallery renders comics
 * from summaries and loads pages only when the reader opens.
 */
export type GalleryBrowseEntry =
  | { hasChildren: boolean; key: `folder:${string}`; kind: "folder"; name: string; path: string }
  | { key: `media:${string}`; kind: "media"; media: LibraryMediaItem }
  | { comic: GalleryComicSummary; key: `comic:${string}`; kind: "comic" };

/** One listing page in display order → grid entries in the same order. */
export function toGalleryBrowseEntries(page: GalleryListingPage): GalleryBrowseEntry[] {
  if (page.subjectKind === "comic") {
    return page.comics.map((comic) => ({ comic, key: `comic:${comic.id}`, kind: "comic" }));
  }
  return page.entries.flatMap((entry): GalleryBrowseEntry[] => {
    if (entry.kind === "folder") {
      return [
        {
          hasChildren: entry.hasChildren,
          key: `folder:${entry.path}`,
          kind: "folder",
          name: entry.name,
          path: entry.path,
        },
      ];
    }
    if (entry.kind === "media") {
      return [{ key: `media:${entry.media.id}`, kind: "media", media: entry.media }];
    }
    return [];
  });
}

/** The media a browse entry stands for in the media sequence, if any. */
export function entryMedia(entry: GalleryBrowseEntry): LibraryMediaItem | null {
  return entry.kind === "media" ? entry.media : entry.kind === "comic" ? entry.comic.cover : null;
}
