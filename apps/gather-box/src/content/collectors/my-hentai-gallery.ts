import type { GalleryCollectResponse, GalleryImage } from "../../shared/types";

const MHG_TITLE_SUFFIX = "Hentai Comic - My Hentai Gallery";
const MHG_GRID_SELECTOR = "ul.comics-grid.clear";
const MHG_IMAGE_SELECTOR = "div.comic-thumb img[src]";

export function collectMyHentaiGalleryData(document: Document, location: Location): GalleryCollectResponse {
  const grid = document.querySelector(MHG_GRID_SELECTOR);
  if (!grid) {
    return {
      ok: false,
      code: "GRID_NOT_FOUND",
      message: "Could not find the comic thumbnail grid on this page."
    };
  }

  const nodes = Array.from(grid.querySelectorAll<HTMLImageElement>(MHG_IMAGE_SELECTOR));
  if (nodes.length === 0) {
    return {
      ok: false,
      code: "NO_IMAGES_FOUND",
      message: "The comic grid was found, but no thumbnail images were detected."
    };
  }

  const imageEntries = nodes.map((node, index) => buildImageEntry(node, index, location));
  const images = imageEntries.filter((image): image is GalleryImage => Boolean(image));
  const skippedCount = imageEntries.length - images.length;
  const title = getComicTitle(document);

  if (images.length === 0) {
    return {
      ok: false,
      code: "NO_VALID_IMAGES",
      message: "No valid thumbnail URLs could be converted into original image URLs."
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "myhentaigallery",
    title,
    pageUrl: location.href,
    galleryId: getGalleryId(location),
    folderSegments: [title],
    skippedCount,
    images
  };
}

function buildImageEntry(
  node: HTMLImageElement,
  index: number,
  location: Location
): GalleryImage | null {
  const thumbnailUrl = node.getAttribute("src");
  if (!thumbnailUrl) {
    return null;
  }

  const originalUrl = rewriteToOriginalUrl(thumbnailUrl, location);
  if (!originalUrl) {
    return null;
  }

  return {
    pageNumber: index + 1,
    thumbnailUrl,
    originalUrl,
    fileName: getFileName(originalUrl)
  };
}

function rewriteToOriginalUrl(thumbnailUrl: string, location: Location): string | null {
  const url = new URL(thumbnailUrl, location.href);
  if (!url.pathname.includes("/thumbnail/")) {
    return null;
  }

  url.pathname = url.pathname.replace("/thumbnail/", "/original/");
  return url.toString();
}

function getFileName(originalUrl: string): string {
  const url = new URL(originalUrl);
  const parts = url.pathname.split("/");
  return parts[parts.length - 1] || "image";
}

function getComicTitle(document: Document): string {
  return document.title.replace(MHG_TITLE_SUFFIX, "").trim();
}

function getGalleryId(location: Location): string | null {
  const match = location.pathname.match(/^\/a\/([^/]+)/);
  return match ? match[1] : null;
}
