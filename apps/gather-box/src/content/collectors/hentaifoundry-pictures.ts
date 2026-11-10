import { getUrlFileName, lowercaseFirstAscii } from "../../shared/path";
import type { CollectorResult } from "../../shared/types";
import { getText } from "../collector-dom";
import type { SourcePage } from "../collector-entry";

const FULL_SIZE_HOST = "pictures.hentai-foundry.com";

const PICTURE_IMAGE_SELECTOR = "#picBox .boxbody img[src]";

const TITLE_SELECTOR = "#picBox .imageTitle";

export function collect(document: Document, page: SourcePage): CollectorResult {
  const { artist, pictureId, title } = page.address;

  if (!artist || !pictureId || !title) {
    return { ok: false, message: "This Hentai Foundry page is not a supported picture URL." };
  }

  const image = document.querySelector<HTMLImageElement>(PICTURE_IMAGE_SELECTOR);

  if (!image) {
    return { ok: false, message: "Could not find the Hentai Foundry picture on this page." };
  }

  const originalUrl = getFullSizeImageUrl(image, page);
  const fileName = originalUrl ? getUrlFileName(originalUrl) : "";

  if (!originalUrl || !fileName) {
    return {
      ok: false,
      message: "Could not find the full-size Hentai Foundry picture URL on this page.",
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    title:
      getText(document.querySelector(TITLE_SELECTOR)) ||
      decodeURIComponent(title).replace(/-/g, " "),
    galleryId: decodeURIComponent(pictureId),
    folderSegments: [lowercaseFirstAscii(decodeURIComponent(artist))],
    images: [{ originalUrl, fileName }],
  };
}

function getFullSizeImageUrl(image: HTMLImageElement, page: SourcePage): string | null {
  const onclick = image.getAttribute("onclick") || "";
  const assignedSource = onclick.match(/this\.src\s*=\s*(['"])(.*?)\1/s)?.[2];

  for (const candidate of [assignedSource, image.getAttribute("src")]) {
    if (!candidate) {
      continue;
    }

    const url = new URL(candidate, page.location.href);

    if (url.protocol === "https:" && url.hostname === FULL_SIZE_HOST) {
      return url.toString();
    }
  }

  return null;
}
