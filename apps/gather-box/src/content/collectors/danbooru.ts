import type { PageLocation } from "../collector-entry";
import type { GalleryCollectResponse } from "../../shared/types";

const POST_PATH_PATTERN = /^\/posts\/(\d+)\/?$/;
const ARTIST_SELECTOR = "#tag-list ul.artist-tag-list > li[data-tag-name]";
const DOWNLOAD_SELECTOR = "#post-option-download a[download][href]";
const ORIGINAL_LINK_SELECTORS = [
  "#post-option-view-original a[href]",
  "#post-info-size a[href]",
  ".image-view-original-link[href]"
];
const IMAGE_CONTAINER_SELECTOR = ".image-container[data-file-url]";
const THUMBNAIL_SELECTOR = ".image-container #image[src]";
const ORIGINAL_MEDIA_HOST = "cdn.donmai.us";

export function collectDanbooruData(
  document: Document,
  location: PageLocation
): GalleryCollectResponse {
  const postId = parsePostId(location);
  if (location.hostname !== "danbooru.donmai.us" || !postId) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This page is not a supported post URL."
    };
  }

  const artist = document.querySelector<HTMLElement>(ARTIST_SELECTOR)?.dataset.tagName?.trim();
  if (!artist) {
    return {
      ok: false,
      code: "AUTHOR_NOT_FOUND",
      message: "Could not find the artist tag on this post."
    };
  }

  const original = findOriginalMedia(document, location);
  if (!original) {
    return {
      ok: false,
      code: "NO_VALID_IMAGES",
      message: "Could not find the original-quality media URL on this post."
    };
  }

  const thumbnail = document.querySelector<HTMLImageElement>(THUMBNAIL_SELECTOR);

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "danbooru",
    title: thumbnail?.alt.trim() || `Post ${postId}`,
    pageUrl: location.href,
    galleryId: postId,
    folderSegments: [artist],
    skippedCount: 0,
    images: [
      {
        pageNumber: 1,
        thumbnailUrl: resolveUrl(thumbnail?.getAttribute("src"), location),
        originalUrl: original.url,
        fileName: original.fileName
      }
    ]
  };
}

function parsePostId(location: PageLocation): string | null {
  return location.pathname.match(POST_PATH_PATTERN)?.[1] ?? null;
}

function findOriginalMedia(
  document: Document,
  location: PageLocation
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

function resolveOriginalUrl(value: string | null | undefined, location: PageLocation): string | null {
  if (!value) {
    return null;
  }

  const url = new URL(value, location.href);
  return url.protocol === "https:" &&
    url.hostname === ORIGINAL_MEDIA_HOST &&
    url.pathname.startsWith("/original/")
    ? url.toString()
    : null;
}

function resolveUrl(value: string | null | undefined, location: PageLocation): string | null {
  return value ? new URL(value, location.href).toString() : null;
}

function getUrlFileName(urlValue: string): string {
  return decodeURIComponent(new URL(urlValue).pathname.split("/").pop() || "");
}
