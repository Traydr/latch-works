const THUMBNAIL_SIZE_LADDER = [160, 320, 480, 640, 720, 960, 1080] as const;

export function snapThumbnailSize(requestedSize: number): number {
  const normalized = Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : 720;

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

export function buildMediaDeliveryApiUrl(
  mediaId: string,
  variant: "thumbnail" | "preview" | "original",
  size?: number,
): string {
  if (variant === "original") {
    return `/api/media/${mediaId}/original`;
  }

  if (variant === "preview") {
    return `/api/media/${mediaId}/preview`;
  }

  return `/api/media/${mediaId}/thumbnail?size=${snapThumbnailSize(size ?? 320)}`;
}
