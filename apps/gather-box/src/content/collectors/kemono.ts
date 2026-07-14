import type { GalleryCollectResponse, GalleryImage } from "../../shared/types";
import { getFileName, getImageSource, getText } from "./utils";

const KEMONO_USER_SELECTOR = "a.post__user-name[href*='/user/']";
const KEMONO_TITLE_SELECTOR = "h1.post__title";
const KEMONO_FILES_SELECTOR = "div.post__files";
const KEMONO_FILE_LINK_SELECTOR = "a.fileThumb.image-link[href]";

export function collectKemonoData(document: Document, location: Location): GalleryCollectResponse {
  const pathMatch = location.pathname.match(/^\/([^/]+)\/user\/([^/]+)\/post\/([^/]+)/);
  if (!pathMatch) {
    return {
      ok: false,
      code: "INVALID_KEMONO_PATH",
      message: "Could not infer the Kemono service or post path from this URL."
    };
  }

  const userType = decodeURIComponent(pathMatch[1]);
  const userNameElement = document.querySelector(KEMONO_USER_SELECTOR);
  const postTitleElement = document.querySelector(KEMONO_TITLE_SELECTOR);
  const filesContainer = document.querySelector(KEMONO_FILES_SELECTOR);

  if (!userNameElement) {
    return {
      ok: false,
      code: "USER_NOT_FOUND",
      message: "Could not find the Kemono user name on this page."
    };
  }

  if (!postTitleElement) {
    return {
      ok: false,
      code: "TITLE_NOT_FOUND",
      message: "Could not find the Kemono post title on this page."
    };
  }

  if (!filesContainer) {
    return {
      ok: false,
      code: "FILES_NOT_FOUND",
      message: "Could not find the Kemono files section on this page."
    };
  }

  const fileLinks = Array.from(
    filesContainer.querySelectorAll<HTMLAnchorElement>(KEMONO_FILE_LINK_SELECTOR)
  );
  if (fileLinks.length === 0) {
    return {
      ok: false,
      code: "NO_FILES_FOUND",
      message: "The Kemono files section was found, but no file links were detected."
    };
  }

  const imageEntries = fileLinks.map((link, index) => buildKemonoFileEntry(link, index, location));
  const images = imageEntries.filter((image): image is GalleryImage => Boolean(image));
  const skippedCount = imageEntries.length - images.length;
  const userName = getText(userNameElement);
  const postTitle = getKemonoPostTitle(postTitleElement);

  if (images.length === 0) {
    return {
      ok: false,
      code: "NO_VALID_FILES",
      message: "No valid Kemono file links could be converted into downloads."
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "kemono",
    title: postTitle,
    pageUrl: location.href,
    galleryId: pathMatch[3],
    folderSegments: [userType, userName, postTitle],
    skippedCount,
    images
  };
}

function buildKemonoFileEntry(
  link: HTMLAnchorElement,
  index: number,
  location: Location
): GalleryImage | null {
  const href = link.getAttribute("href");
  if (!href) {
    return null;
  }

  const originalUrl = new URL(href, location.href).toString();
  const fileName = link.getAttribute("download") || getFileName(originalUrl);
  const image = link.querySelector<HTMLImageElement>("img");

  return {
    pageNumber: index + 1,
    thumbnailUrl: image ? getImageSource(image, location) : null,
    originalUrl,
    fileName
  };
}

function getKemonoPostTitle(titleElement: Element): string {
  const primarySpan = titleElement.querySelector("span");
  return getText(primarySpan || titleElement);
}
