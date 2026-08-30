import type { PageLocation } from "../collector-entry";
import type { GalleryCollectResponse, GalleryImage } from "../../shared/types";

const KEMONO_USER_SELECTOR = "a.post__user-name[href*='/user/']";
const KEMONO_TITLE_SELECTOR = "h1.post__title";
const KEMONO_FILES_SELECTOR = "div.post__files";
const KEMONO_FILE_LINK_SELECTOR = "a.fileThumb.image-link[href]";
const KEMONO_THUMBNAIL_IMAGE_SELECTOR = ".post__thumbnail img";

export function collectKemonoData(document: Document, location: PageLocation): GalleryCollectResponse {
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
  const thumbnailImages =
    fileLinks.length === 0
      ? Array.from(
          filesContainer.querySelectorAll<HTMLImageElement>(KEMONO_THUMBNAIL_IMAGE_SELECTOR)
        )
      : [];
  if (fileLinks.length === 0 && thumbnailImages.length === 0) {
    return {
      ok: false,
      code: "NO_FILES_FOUND",
      message: "The Kemono files section was found, but no downloadable files were detected."
    };
  }

  const imageEntries =
    fileLinks.length > 0
      ? fileLinks.map((link, index) => buildKemonoFileEntry(link, index, location))
      : thumbnailImages.map((image, index) =>
          buildKemonoThumbnailEntry(image, index, location)
        );
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
  location: PageLocation
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

function buildKemonoThumbnailEntry(
  image: HTMLImageElement,
  index: number,
  location: PageLocation
): GalleryImage | null {
  const imageUrl = getImageSource(image, location);
  if (!imageUrl) {
    return null;
  }

  return {
    pageNumber: index + 1,
    thumbnailUrl: imageUrl,
    originalUrl: imageUrl,
    fileName: getFileName(imageUrl)
  };
}

function getFileName(originalUrl: string): string {
  const url = new URL(originalUrl);
  const parts = url.pathname.split("/");
  return parts[parts.length - 1] || "image";
}

function getKemonoPostTitle(titleElement: Element): string {
  const primarySpan = titleElement.querySelector("span");
  return getText(primarySpan || titleElement);
}

function getImageSource(image: HTMLImageElement, location: PageLocation): string | null {
  const rawSource = image.getAttribute("data-src") || image.getAttribute("src");
  if (!rawSource) {
    return null;
  }

  return new URL(rawSource, location.href).toString();
}

function getText(element: Element | null): string {
  return element ? element.textContent?.trim() || "" : "";
}
