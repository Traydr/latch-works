import { snapThumbnailSize } from "@latch-works/media-delivery";

export const DEFAULT_CARD_WIDTH = 220;

export function resolveRequestedThumbnailSize(cardWidth: number): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return snapThumbnailSize(Math.round(cardWidth * dpr));
}

export function buildThumbnailRequestUrl(mediaId: string, cardWidth: number): string {
  const size = resolveRequestedThumbnailSize(cardWidth);
  return `/api/media/${mediaId}/thumbnail?size=${size}`;
}
