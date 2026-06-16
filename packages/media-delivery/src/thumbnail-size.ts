export const THUMBNAIL_SIZE_LADDER = [160, 320, 480, 640, 960] as const;

export type ThumbnailSize = (typeof THUMBNAIL_SIZE_LADDER)[number];

/**
 * Fixed size used for gallery grid tiles. The library snapshot joins ready
 * derivatives at this size and embeds their delivery URLs, and the client
 * fallback requests the same size, so generated derivatives always match what
 * the snapshot can embed on the next load.
 */
export const GALLERY_THUMBNAIL_SIZE: ThumbnailSize = 320;

/**
 * Fixed size used for fullscreen/detail previews. The library snapshot can
 * embed ready derivatives at this size, and `/api/media/:id/preview` always
 * requests this ladder step.
 */
export const PREVIEW_DERIVATIVE_SIZE: ThumbnailSize = 960;

export function snapThumbnailSize(requestedSize: number): ThumbnailSize {
  const normalized = Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : 320;

  let closest: ThumbnailSize = THUMBNAIL_SIZE_LADDER[0];
  let closestDistance = Math.abs(normalized - closest);

  for (const size of THUMBNAIL_SIZE_LADDER) {
    const distance = Math.abs(normalized - size);
    if (distance < closestDistance) {
      closest = size;
      closestDistance = distance;
    }
  }

  return closest;
}
