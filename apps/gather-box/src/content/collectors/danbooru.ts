import { getUrlFileName } from "../../shared/path";
import type { CollectorResult } from "../../shared/types";
import { resolveUrl } from "../collector-dom";
import type { PageLocation, SourcePage } from "../collector-entry";

const ARTIST_SELECTOR = "#tag-list ul.artist-tag-list > li[data-tag-name]";

const DOWNLOAD_SELECTOR = "#post-option-download a[download][href]";

const ORIGINAL_LINK_SELECTORS = [
  "#post-option-view-original a[href]",
  "#post-info-size a[href]",
  ".image-view-original-link[href]",
];

const IMAGE_CONTAINER_SELECTOR = ".image-container[data-file-url]";

const THUMBNAIL_SELECTOR = ".image-container #image[src]";

const ORIGINAL_MEDIA_HOST = "cdn.donmai.us";

export function collect(document: Document, page: SourcePage): CollectorResult {
  const { postId } = page.address;

  if (!postId) {
    return { ok: false, message: "This page is not a supported post URL." };
  }

  const artist = document.querySelector<HTMLElement>(ARTIST_SELECTOR)?.dataset.tagName?.trim();

  if (!artist) {
    return { ok: false, message: "Could not find the artist tag on this post." };
  }

  const original = findOriginalMedia(document, page.location);

  if (!original) {
    return { ok: false, message: "Could not find the original-quality media URL on this post." };
  }

  const thumbnail = document.querySelector<HTMLImageElement>(THUMBNAIL_SELECTOR);

  return {
    ok: true,
    outputKind: "downloadable-files",
    title: thumbnail?.alt.trim() || `Post ${postId}`,
    galleryId: postId,
    folderSegments: [artist],
    images: [{ originalUrl: original.url, fileName: original.fileName }],
  };
}

function findOriginalMedia(
  document: Document,
  location: PageLocation,
): { url: string; fileName: string } | null {
  const download = document.querySelector<HTMLAnchorElement>(DOWNLOAD_SELECTOR);

  if (download) {
    const url = resolveOriginalUrl(download.getAttribute("href"), location);
    const fileName = download.getAttribute("download")?.trim();

    if (url && fileName) {
      return { url, fileName };
    }
  }

  for (const selector of ORIGINAL_LINK_SELECTORS) {
    const link = document.querySelector<HTMLAnchorElement>(selector);
    const url = resolveOriginalUrl(link?.getAttribute("href"), location);

    if (url) {
      return { url, fileName: getUrlFileName(url) };
    }
  }

  const container = document.querySelector<HTMLElement>(IMAGE_CONTAINER_SELECTOR);
  const url = resolveOriginalUrl(container?.dataset.fileUrl, location);

  return url ? { url, fileName: getUrlFileName(url) } : null;
}

function resolveOriginalUrl(
  value: string | null | undefined,
  location: PageLocation,
): string | null {
  const resolved = resolveUrl(value, location);

  if (!resolved) {
    return null;
  }

  const url = new URL(resolved);

  return url.protocol === "https:" &&
    url.hostname === ORIGINAL_MEDIA_HOST &&
    url.pathname.startsWith("/original/")
    ? resolved
    : null;
}
