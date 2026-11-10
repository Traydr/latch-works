import { getUrlFileName } from "../../shared/path";
import type { CollectorResult, DownloadableFile } from "../../shared/types";
import { getImageSource, getText, resolveUrl } from "../collector-dom";
import type { SourcePage } from "../collector-entry";

const KEMONO_USER_SELECTOR = "a.post__user-name[href*='/user/']";

const KEMONO_TITLE_SELECTOR = "h1.post__title";

const KEMONO_FILES_SELECTOR = "div.post__files";

const KEMONO_FILE_LINK_SELECTOR = "a.fileThumb.image-link[href]";

const KEMONO_THUMBNAIL_IMAGE_SELECTOR = ".post__thumbnail img";

export function collect(document: Document, page: SourcePage): CollectorResult {
  const { service, postId } = page.address;

  if (!service || !postId) {
    return { ok: false, message: "Could not infer the Kemono service or post path from this URL." };
  }

  const userNameElement = document.querySelector(KEMONO_USER_SELECTOR);
  const postTitleElement = document.querySelector(KEMONO_TITLE_SELECTOR);
  const filesContainer = document.querySelector(KEMONO_FILES_SELECTOR);

  if (!userNameElement) {
    return { ok: false, message: "Could not find the Kemono user name on this page." };
  }

  if (!postTitleElement) {
    return { ok: false, message: "Could not find the Kemono post title on this page." };
  }

  if (!filesContainer) {
    return { ok: false, message: "Could not find the Kemono files section on this page." };
  }

  const fileLinks = Array.from(
    filesContainer.querySelectorAll<HTMLAnchorElement>(KEMONO_FILE_LINK_SELECTOR),
  );

  const thumbnailImages =
    fileLinks.length === 0
      ? Array.from(
          filesContainer.querySelectorAll<HTMLImageElement>(KEMONO_THUMBNAIL_IMAGE_SELECTOR),
        )
      : [];

  if (fileLinks.length === 0 && thumbnailImages.length === 0) {
    return {
      ok: false,
      message: "The Kemono files section was found, but no downloadable files were detected.",
    };
  }

  const entries =
    fileLinks.length > 0
      ? fileLinks.map((link) => buildFileEntry(link, page))
      : thumbnailImages.map((image) => buildThumbnailEntry(image, page));

  const images = entries.flatMap((image) => (image ? [image] : []));
  const postTitle = getText(postTitleElement.querySelector("span") || postTitleElement);

  if (images.length === 0) {
    return { ok: false, message: "No valid Kemono file links could be converted into downloads." };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    title: postTitle,
    galleryId: postId,
    folderSegments: [decodeURIComponent(service), getText(userNameElement), postTitle],
    images,
  };
}

function buildFileEntry(link: HTMLAnchorElement, page: SourcePage): DownloadableFile | null {
  const originalUrl = resolveUrl(link.getAttribute("href"), page.location);

  if (!originalUrl) {
    return null;
  }

  return {
    originalUrl,
    fileName: link.getAttribute("download") || getUrlFileName(originalUrl) || "image",
  };
}

function buildThumbnailEntry(image: HTMLImageElement, page: SourcePage): DownloadableFile | null {
  const imageUrl = getImageSource(image, page.location);

  return imageUrl ? { originalUrl: imageUrl, fileName: getUrlFileName(imageUrl) || "image" } : null;
}
