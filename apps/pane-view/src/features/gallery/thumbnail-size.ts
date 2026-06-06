export const DEFAULT_CARD_WIDTH = 220;

const THUMBNAIL_SIZE_LADDER = [160, 320, 480, 640, 960] as const;

function snapThumbnailSize(requestedSize: number): number {
  const normalized = Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : 320;

  let closest: (typeof THUMBNAIL_SIZE_LADDER)[number] = THUMBNAIL_SIZE_LADDER[0];
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

export function resolveRequestedThumbnailSize(cardWidth: number, devicePixelRatio = 1): number {
  return snapThumbnailSize(Math.round(cardWidth * devicePixelRatio));
}

export function buildThumbnailRequestUrl(mediaId: string, cardWidth: number): string {
  const size = resolveRequestedThumbnailSize(cardWidth);
  return `/api/media/${mediaId}/thumbnail?size=${size}`;
}
