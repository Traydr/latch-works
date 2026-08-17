import { createHash } from "node:crypto";
import type { BrowserEntry, GallerySortMode } from "@latch-works/media-domain";
import type { LibraryMediaItem } from "./types";

export const DEFAULT_GALLERY_LISTING_LIMIT = 60;

export interface GalleryListingPage {
  entries: BrowserEntry[];
  media: LibraryMediaItem[];
  page: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
  };
}

export interface GalleryListingCursorPayload {
  filename: string;
  id: string;
  logicalPath: string;
  mtimeMs: number;
  randomHash?: string;
  randomSeed?: string;
  sortMode: GallerySortMode;
}

export function galleryListingRandomHash(seed: string, id: string): string {
  return createHash("md5").update(`${seed}:${id}`).digest("hex");
}

export function encodeGalleryListingCursor(payload: GalleryListingCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeGalleryListingCursor(
  encoded: string | undefined,
): GalleryListingCursorPayload | null {
  if (!encoded) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as
      | GalleryListingCursorPayload
      | undefined;
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof parsed.logicalPath !== "string" ||
      typeof parsed.filename !== "string" ||
      typeof parsed.mtimeMs !== "number" ||
      typeof parsed.sortMode !== "string"
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
