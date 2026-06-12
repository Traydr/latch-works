import { sanitizeFileName } from "./path";
import type { SiteKey } from "./sites";
import type { GalleryImage } from "./types";

const DOWNLOAD_URL_POLICIES: Record<SiteKey, RegExp[]> = {
  archiveofourown: [/^https:\/\/archiveofourown\.org\/.+/],
  fanbox: [/^https:\/\/downloads\.fanbox\.cc\/.+/],
  "fanfiction-net": [/^https:\/\/www\.fanfiction\.net\/.+/],
  "hentaifoundry-stories": [/^https:\/\/www\.hentai-foundry\.com\/.+/],
  kemono: [/^https:\/\/(?:[a-z0-9-]+\.)?kemono\.cr\/.+/],
  myhentaigallery: [/^https:\/\/(?:www\.)?myhentaigallery\.com\/.+\/original\/.+/],
};

export function isAllowedDownloadUrl(site: SiteKey, url: string): boolean {
  return DOWNLOAD_URL_POLICIES[site].some((pattern) => pattern.test(url));
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
    fileName,
  };
}
