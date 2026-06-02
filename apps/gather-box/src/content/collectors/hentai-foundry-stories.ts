import { buildStoryPdfFileName } from "../../shared/path";
import type { GalleryCollectResponse } from "../../shared/types";

const HF_PDF_LINK_SELECTOR = 'a.pdfLink[href$=".pdf"]';
const HF_STORY_TITLE_FALLBACK_SELECTOR = '.storyRow .titlebar a[href*="/stories/user/"]';
const HF_AUTHOR_FALLBACK_SELECTOR = '.storyInfo a[href*="/profile"]';

interface HentaiFoundryStoryPath {
  author: string;
  storyId: string;
  storyTitle: string;
}

export function collectHentaiFoundryStoriesData(
  document: Document,
  location: Location
): GalleryCollectResponse {
  if (location.hostname !== "www.hentai-foundry.com" || !location.pathname.startsWith("/stories/user/")) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This Hentai Foundry page is not a supported story URL."
    };
  }

  const pdfUrl = getPdfUrl(document, location);
  if (!pdfUrl) {
    return {
      ok: false,
      code: "PDF_LINK_NOT_FOUND",
      message: "Could not find the Hentai Foundry story PDF link on this page."
    };
  }

  const storyPath = parseStoryPath(location);
  const author = storyPath?.author || getText(document.querySelector(HF_AUTHOR_FALLBACK_SELECTOR));
  if (!author) {
    return {
      ok: false,
      code: "AUTHOR_NOT_FOUND",
      message: "Could not find the Hentai Foundry story author on this page."
    };
  }

  const title = storyPath?.storyTitle || getText(document.querySelector(HF_STORY_TITLE_FALLBACK_SELECTOR));
  if (!title) {
    return {
      ok: false,
      code: "TITLE_NOT_FOUND",
      message: "Could not find the Hentai Foundry story title on this page."
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "hentaifoundry-stories",
    title,
    pageUrl: location.href,
    galleryId: storyPath?.storyId || null,
    folderSegments: [],
    skippedCount: 0,
    images: [
      {
        pageNumber: 1,
        thumbnailUrl: null,
        originalUrl: pdfUrl,
        fileName: buildStoryPdfFileName(author, title)
      }
    ]
  };
}

function getPdfUrl(document: Document, location: Location): string | null {
  const link = document.querySelector<HTMLAnchorElement>(HF_PDF_LINK_SELECTOR);
  const href = link?.getAttribute("href");

  return href ? new URL(href, location.href).toString() : null;
}

function parseStoryPath(location: Location): HentaiFoundryStoryPath | null {
  const parts = location.pathname.split("/").filter(Boolean);
  if (
    parts.length < 5 ||
    parts[0] !== "stories" ||
    parts[1] !== "user" ||
    !parts[2] ||
    !parts[3] ||
    !parts[4]
  ) {
    return null;
  }

  return {
    author: decodeURIComponent(parts[2]),
    storyId: decodeURIComponent(parts[3]),
    storyTitle: decodeURIComponent(parts[4]).replace(/-/g, " ")
  };
}

function getText(element: Element | null): string {
  return element ? element.textContent?.trim() || "" : "";
}
