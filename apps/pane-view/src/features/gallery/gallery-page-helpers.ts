import type { GallerySortMode, MediaItem } from "@latch-works/media-domain";
import type { GalleryThumbnailRequest } from "@/features/gallery/batched-thumbnail-resolver";
import type { GalleryRandomSeed } from "@/features/gallery/gallery-random-seed";

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

/**
 * Identity of one browse population. When it changes, accumulated pages,
 * pagination state, and thumbnail resolution all start over.
 */
export function buildBrowseKey(parts: {
  comicMode: boolean;
  path: string | undefined;
  query: string | undefined;
  randomSeed: GalleryRandomSeed;
  recursive: boolean;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}): string {
  return [
    parts.path ?? "",
    parts.query ?? "",
    parts.recursive,
    parts.comicMode,
    parts.randomSeed,
    parts.showImages,
    parts.showVideos,
    parts.sortMode,
  ].join("|");
}
