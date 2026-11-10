import { sanitizeFileName } from "./path";
import { getGatherSource, type SiteKey } from "./source-catalog";
import type { DownloadableFile } from "./types";

export function isAllowedDownloadUrl(site: SiteKey, url: string): boolean {
  return getGatherSource(site)?.downloadUrlPatterns.some((pattern) => pattern.test(url)) ?? false;
}

export function prepareDownloadImage(
  site: SiteKey,
  image: DownloadableFile,
): DownloadableFile | null {
  if (!isAllowedDownloadUrl(site, image.originalUrl)) {
    return null;
  }

  const fileName = sanitizeFileName(image.fileName);

  if (!fileName) {
    return null;
  }

  return {
    ...image,
    fileName,
  };
}
