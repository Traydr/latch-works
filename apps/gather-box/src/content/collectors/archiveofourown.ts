import { buildStoryPdfFileName } from "../../shared/path";
import type { CollectorResult } from "../../shared/types";
import { getText } from "../collector-dom";
import type { PageLocation, SourcePage } from "../collector-entry";

const AO3_PDF_LINK_SELECTOR = 'li.download a[href*=".pdf"]';

const AO3_TITLE_SELECTOR = "#workskin h2.title.heading";

const AO3_BYLINE_SELECTOR = "#workskin h3.byline.heading";

const AO3_AUTHOR_SELECTOR = '#workskin h3.byline.heading a[rel="author"]';

export function collect(document: Document, page: SourcePage): CollectorResult {
  const { workId } = page.address;

  if (!workId) {
    return { ok: false, message: "This AO3 page is not a supported work URL." };
  }

  const pdfUrl = getPdfUrl(document, page.location);

  if (!pdfUrl) {
    return {
      ok: false,
      message: "Could not find the AO3 PDF download link on this page.",
    };
  }

  const title = getText(document.querySelector(AO3_TITLE_SELECTOR));

  if (!title) {
    return {
      ok: false,
      message: "Could not find the AO3 work title on this page.",
    };
  }

  const author = getAuthors(document);

  if (!author) {
    return {
      ok: false,
      message: "Could not find the AO3 author name on this page.",
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    title,
    galleryId: workId,
    folderSegments: [],
    images: [{ originalUrl: pdfUrl, fileName: buildStoryPdfFileName(author, title) }],
  };
}

function getPdfUrl(document: Document, location: PageLocation): string | null {
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
