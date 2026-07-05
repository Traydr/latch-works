import type { MediaItem } from "@latch-works/media-domain";
import type { GalleryThumbnailRequest } from "@/features/gallery/batched-thumbnail-resolver";
import type { LibraryMediaItem } from "@/server/library/types";

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

export function supportsGalleryThumbnail(media: MediaItem): boolean {
  return media.mediaType === "image" || media.mediaType === "gif" || media.mediaType === "video";
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
