import { buildStoryPdfFileName } from "../../shared/path";
import type { GalleryCollectResponse } from "../../shared/types";

const AO3_PDF_LINK_SELECTOR = 'li.download a[href*=".pdf"]';
const AO3_TITLE_SELECTOR = "#workskin h2.title.heading";
const AO3_BYLINE_SELECTOR = "#workskin h3.byline.heading";
const AO3_AUTHOR_SELECTOR = '#workskin h3.byline.heading a[rel="author"]';

export function collectArchiveOfOurOwnData(
  document: Document,
  location: Location
): GalleryCollectResponse {
  if (location.hostname !== "archiveofourown.org" || !location.pathname.startsWith("/works/")) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This AO3 page is not a supported work URL."
    };
  }

  const pdfUrl = getPdfUrl(document, location);
  if (!pdfUrl) {
    return {
      ok: false,
      code: "PDF_LINK_NOT_FOUND",
      message: "Could not find the AO3 PDF download link on this page."
    };
  }

  const title = getText(document.querySelector(AO3_TITLE_SELECTOR));
  if (!title) {
    return {
      ok: false,
      code: "TITLE_NOT_FOUND",
      message: "Could not find the AO3 work title on this page."
    };
  }

  const author = getAuthors(document);
  if (!author) {
    return {
      ok: false,
      code: "AUTHOR_NOT_FOUND",
      message: "Could not find the AO3 author name on this page."
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "archiveofourown",
    title,
    pageUrl: location.href,
    galleryId: getWorkId(location),
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
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(AO3_PDF_LINK_SELECTOR));

  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) {
      continue;
    }

    const url = new URL(href, location.href);
    if (url.pathname.toLowerCase().endsWith(".pdf")) {
      return url.toString();
    }
  }

  return null;
}

function getAuthors(document: Document): string {
  const authors = Array.from(document.querySelectorAll(AO3_AUTHOR_SELECTOR))
    .map(getText)
    .filter(Boolean);

  if (authors.length > 0) {
    return authors.join("_and_");
  }

  return getText(document.querySelector(AO3_BYLINE_SELECTOR));
}

function getWorkId(location: Location): string | null {
  const match = location.pathname.match(/^\/works\/([^/]+)/);
  return match ? match[1] : null;
}

function getText(element: Element | null): string {
  return element ? element.textContent?.trim() || "" : "";
}
