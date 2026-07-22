import type { GalleryCollectResponse } from "../../shared/types";
import { lowercaseFirstAscii } from "../../shared/path";

const PICTURE_PATH_PATTERN = /^\/pictures\/user\/([^/]+)\/([^/]+)\/([^/?#]+)/;
const FULL_SIZE_HOST = "pictures.hentai-foundry.com";
const PICTURE_IMAGE_SELECTOR = "#picBox .boxbody img[src]";
const TITLE_SELECTOR = "#picBox .imageTitle";

interface HentaiFoundryPicturePath {
  artist: string;
  pictureId: string;
  title: string;
}

export function collectHentaiFoundryPicturesData(
  document: Document,
  location: Location
): GalleryCollectResponse {
  const picturePath = parsePicturePath(location);
  if (location.hostname !== "www.hentai-foundry.com" || !picturePath) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This Hentai Foundry page is not a supported picture URL."
    };
  }

  const image = document.querySelector<HTMLImageElement>(PICTURE_IMAGE_SELECTOR);
  if (!image) {
    return {
      ok: false,
      code: "NO_IMAGES_FOUND",
      message: "Could not find the Hentai Foundry picture on this page."
    };
  }

  const originalUrl = getFullSizeImageUrl(image, location);
  const fileName = originalUrl ? getUrlFileName(originalUrl) : "";
  if (!originalUrl || !fileName) {
    return {
      ok: false,
      code: "NO_VALID_IMAGES",
      message: "Could not find the full-size Hentai Foundry picture URL on this page."
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "hentaifoundry-pictures",
    title: getText(document.querySelector(TITLE_SELECTOR)) || picturePath.title,
    pageUrl: location.href,
    galleryId: picturePath.pictureId,
    folderSegments: [lowercaseFirstAscii(picturePath.artist)],
    skippedCount: 0,
    images: [
      {
        pageNumber: 1,
        thumbnailUrl: new URL(image.getAttribute("src") || image.src, location.href).toString(),
        originalUrl,
        fileName
      }
    ]
  };
}

function parsePicturePath(location: Location): HentaiFoundryPicturePath | null {
  const match = location.pathname.match(PICTURE_PATH_PATTERN);
  if (!match) {
    return null;
  }

  return {
    artist: decodeURIComponent(match[1]),
    pictureId: decodeURIComponent(match[2]),
    title: decodeURIComponent(match[3]).replace(/-/g, " ")
  };
}

function getFullSizeImageUrl(image: HTMLImageElement, location: Location): string | null {
  const onclick = image.getAttribute("onclick") || "";
  const assignedSource = onclick.match(/this\.src\s*=\s*(['"])(.*?)\1/s)?.[2];
  const candidates = [assignedSource, image.getAttribute("src")];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const url = new URL(candidate, location.href);
    if (url.protocol === "https:" && url.hostname === FULL_SIZE_HOST) {
      return url.toString();
    }
  }

  return null;
}

function getUrlFileName(urlValue: string): string {
  return decodeURIComponent(new URL(urlValue).pathname.split("/").pop() || "");
}

function getText(element: Element | null): string {
  return element?.textContent?.trim() || "";
}
