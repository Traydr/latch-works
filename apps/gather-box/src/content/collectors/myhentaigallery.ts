import { getUrlFileName } from "../../shared/path";
import type { CollectorResult, DownloadableFile } from "../../shared/types";
import type { SourcePage } from "../collector-entry";

const MHG_TITLE_SUFFIX = "Hentai Comic - My Hentai Gallery";

const MHG_GRID_SELECTOR = "ul.comics-grid.clear";

const MHG_IMAGE_SELECTOR = "div.comic-thumb img[src]";

export function collect(document: Document, page: SourcePage): CollectorResult {
  const grid = document.querySelector(MHG_GRID_SELECTOR);

  if (!grid) {
    return { ok: false, message: "Could not find the comic thumbnail grid on this page." };
  }

  const nodes = Array.from(grid.querySelectorAll<HTMLImageElement>(MHG_IMAGE_SELECTOR));

  if (nodes.length === 0) {
    return {
      ok: false,
      message: "The comic grid was found, but no thumbnail images were detected.",
    };
  }

  const images = nodes.flatMap((node) => {
    const image = buildImageEntry(node, page);

    return image ? [image] : [];
  });

  const title = document.title.replace(MHG_TITLE_SUFFIX, "").trim();

  if (images.length === 0) {
    return {
      ok: false,
      message: "No valid thumbnail URLs could be converted into original image URLs.",
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    title,
    galleryId: page.address.galleryId ?? null,
    folderSegments: [title],
    images,
  };
}

function buildImageEntry(node: HTMLImageElement, page: SourcePage): DownloadableFile | null {
  const thumbnailUrl = node.getAttribute("src");

  if (!thumbnailUrl) {
    return null;
  }

  const url = new URL(thumbnailUrl, page.location.href);

  if (!url.pathname.includes("/thumbnail/")) {
    return null;
  }

  url.pathname = url.pathname.replace("/thumbnail/", "/original/");

  return { originalUrl: url.toString(), fileName: getUrlFileName(url.toString()) || "image" };
}
