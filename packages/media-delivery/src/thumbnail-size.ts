export const THUMBNAIL_SIZE_LADDER = [160, 320, 480, 640, 960] as const;

export type ThumbnailSize = (typeof THUMBNAIL_SIZE_LADDER)[number];

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
