import type { PageLocation } from "../collector-entry";
import type { GalleryCollectResponse, GalleryImage } from "../../shared/types";

const ORIGINAL_IMAGE_PREFIX = "https://i.pximg.net/img-original/";

export function collectPixivData(document: Document, location: PageLocation): GalleryCollectResponse {
  const artworkId = getArtworkId(location);
  if (!artworkId) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This pixiv page is not a supported artwork URL."
    };
  }

  const firstOriginal = document.querySelector<HTMLAnchorElement>(
    `a[href^="${ORIGINAL_IMAGE_PREFIX}"][href*="/${artworkId}_p0."]`
  );
  if (!firstOriginal?.href) {
    return {
      ok: false,
      code: "NO_IMAGES_FOUND",
      message: "Could not find the original pixiv image URL on this page."
    };
  }

  const creator = getCreator(firstOriginal, location);
  if (!creator) {
    return {
      ok: false,
      code: "USER_NOT_FOUND",
      message: "Could not find the pixiv creator name and user ID on this page."
    };
  }

  const images = buildPixivImages(document, firstOriginal.href, artworkId);
  if (images.length === 0) {
    return {
      ok: false,
      code: "NO_VALID_IMAGES",
      message: "No valid original pixiv images could be prepared for download."
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "pixiv",
    title: getArtworkTitle(document) || `pixiv artwork ${artworkId}`,
    pageUrl: location.href,
    galleryId: artworkId,
    folderSegments: [`${creator.name}-${creator.id}`],
    skippedCount: 0,
    images
  };
}

function buildPixivImages(
  document: Document,
  firstOriginalUrl: string,
  artworkId: string
): GalleryImage[] {
  const explicitUrls = new Map<number, string>();
  const originalLinks = document.querySelectorAll<HTMLAnchorElement>(
    `a[href^="${ORIGINAL_IMAGE_PREFIX}"][href*="/${artworkId}_p"]`
  );

  for (const link of originalLinks) {
    const pageNumber = getPixivPageNumber(link.href, artworkId);
    if (pageNumber !== null) {
      explicitUrls.set(pageNumber, link.href);
    }
  }

  const explicitPageCount = Math.max(0, ...Array.from(explicitUrls.keys(), (index) => index + 1));
  const pageCount = Math.max(getPageCount(document), explicitPageCount, 1);
  const images: GalleryImage[] = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const originalUrl = explicitUrls.get(pageIndex) ?? derivePageUrl(firstOriginalUrl, pageIndex);
    if (!isOriginalPixivUrl(originalUrl, artworkId, pageIndex)) {
      continue;
    }

    images.push({
      pageNumber: pageIndex + 1,
      thumbnailUrl: null,
      originalUrl,
      fileName: getUrlFileName(originalUrl)
    });
  }

  return images;
}

function getCreator(
  firstOriginal: HTMLAnchorElement,
  location: PageLocation
): { id: string; name: string } | null {
  const artworkSection = firstOriginal.closest("section");
  const candidates = artworkSection?.querySelectorAll<HTMLAnchorElement>('a[href*="/users/"]') ?? [];

  for (const link of candidates) {
    const url = new URL(link.href, location.href);
    const match = url.pathname.match(/^\/(?:[a-z]{2}\/)?users\/(\d+)\/?$/i);
    const name = link.textContent?.trim() ?? "";
    if (match && name) {
      return { id: match[1], name };
    }
  }

  return null;
}

function getArtworkTitle(document: Document): string {
  const original = document.querySelector<HTMLAnchorElement>(`a[href^="${ORIGINAL_IMAGE_PREFIX}"]`);
  return original?.closest("section")?.querySelector("h1")?.textContent?.trim() ?? "";
}

function getPageCount(document: Document): number {
  const previewText = document.querySelector('[aria-label="Preview"]')?.textContent ?? "";
  const match = previewText.match(/\d+\s*\/\s*(\d+)/);
  return match ? Number(match[1]) : 1;
}

function getArtworkId(location: PageLocation): string | null {
  return location.pathname.match(/^\/(?:[a-z]{2}\/)?artworks\/(\d+)/i)?.[1] ?? null;
}

function getPixivPageNumber(urlValue: string, artworkId: string): number | null {
  const fileName = getUrlFileName(urlValue);
  const match = fileName.match(new RegExp(`^${artworkId}_p(\\d+)\\.[A-Za-z0-9]+$`));
  return match ? Number(match[1]) : null;
}

function derivePageUrl(firstOriginalUrl: string, pageIndex: number): string {
  const url = new URL(firstOriginalUrl);
  url.pathname = url.pathname.replace(/_p0(?=\.[A-Za-z0-9]+$)/, `_p${pageIndex}`);
  return url.toString();
}

function isOriginalPixivUrl(urlValue: string, artworkId: string, pageIndex: number): boolean {
  const url = new URL(urlValue);
  return (
    url.hostname === "i.pximg.net" &&
    url.pathname.startsWith("/img-original/") &&
    getUrlFileName(urlValue).startsWith(`${artworkId}_p${pageIndex}.`)
  );
}

function getUrlFileName(urlValue: string): string {
  return decodeURIComponent(new URL(urlValue).pathname.split("/").pop() ?? "image");
}
