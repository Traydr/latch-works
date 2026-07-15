import { sanitizeFileName } from "./path";
import { getGatherSource, type SiteKey } from "./source-catalog";
import type { GalleryImage } from "./types";

export function isAllowedDownloadUrl(site: SiteKey, url: string): boolean {
  return getGatherSource(site)?.downloadUrlPatterns.some((pattern) => pattern.test(url)) ?? false;
}

export function prepareDownloadImage(site: SiteKey, image: GalleryImage): GalleryImage | null {
  if (!isAllowedDownloadUrl(site, image.originalUrl)) {
    return null;
  }

  const fileName = sanitizeFileName(image.fileName);
  if (!fileName) {
    return null;
  }

  return {
    ...image,
    fileName
  };
}
