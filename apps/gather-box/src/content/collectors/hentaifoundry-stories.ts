import { buildStoryPdfFileName } from "../../shared/path";
import type { CollectorResult } from "../../shared/types";
import { getText, resolveUrl } from "../collector-dom";
import type { SourcePage } from "../collector-entry";

const HF_PDF_LINK_SELECTOR = 'a.pdfLink[href$=".pdf"]';

const HF_STORY_TITLE_FALLBACK_SELECTOR = '.storyRow .titlebar a[href*="/stories/user/"]';

const HF_AUTHOR_FALLBACK_SELECTOR = '.storyInfo a[href*="/profile"]';

export function collect(document: Document, page: SourcePage): CollectorResult {
  const { address } = page;

  const pdfUrl = resolveUrl(
    document.querySelector<HTMLAnchorElement>(HF_PDF_LINK_SELECTOR)?.getAttribute("href"),
    page.location,
  );

  if (!pdfUrl) {
    return {
      ok: false,
      message: "Could not find the Hentai Foundry story PDF link on this page.",
    };
  }

  const author =
    decodeAddressPart(address.author) ||
    getText(document.querySelector(HF_AUTHOR_FALLBACK_SELECTOR));

  if (!author) {
    return {
      ok: false,
      message: "Could not find the Hentai Foundry story author on this page.",
    };
  }

  const title =
    decodeAddressPart(address.title).replace(/-/g, " ") ||
    getText(document.querySelector(HF_STORY_TITLE_FALLBACK_SELECTOR));

  if (!title) {
    return {
      ok: false,
      message: "Could not find the Hentai Foundry story title on this page.",
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    title,
    galleryId: decodeAddressPart(address.storyId) || null,
    folderSegments: [],
    images: [{ originalUrl: pdfUrl, fileName: buildStoryPdfFileName(author, title) }],
  };
}

function decodeAddressPart(value: string | undefined): string {
  return value ? decodeURIComponent(value) : "";
}
