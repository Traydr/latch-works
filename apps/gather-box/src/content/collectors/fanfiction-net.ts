import { buildStoryPdfFileName } from "../../shared/path";
import type { GalleryCollectResponse, StoryChapterReference } from "../../shared/types";
import { getText as getElementText } from "./utils";

const FFN_HOSTNAME = "www.fanfiction.net";
const FFN_TITLE_SELECTOR = "#profile_top b.xcontrast_txt";
const FFN_AUTHOR_SELECTOR = '#profile_top a.xcontrast_txt[href^="/u/"]';
const FFN_SUMMARY_SELECTOR = "#profile_top div.xcontrast_txt";
const FFN_METADATA_SELECTOR = "#profile_top span.xgray.xcontrast_txt";
const FFN_CHAPTER_SELECTOR = "select#chap_select";

interface FanfictionStoryPath {
  storyId: string;
  chapter: number;
  slug: string;
}

export function collectFanfictionNetData(document: Document, location: Location): GalleryCollectResponse {
  if (location.hostname !== FFN_HOSTNAME) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This fanfiction.net page is not a supported story URL."
    };
  }

  const storyPath = parseStoryPath(location);
  if (!storyPath) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This fanfiction.net page is not a supported story URL."
    };
  }

  const title = getText(document.querySelector(FFN_TITLE_SELECTOR)) || getTitleFallback(document);
  if (!title) {
    return {
      ok: false,
      code: "TITLE_NOT_FOUND",
      message: "Could not find the fanfiction.net story title on this page."
    };
  }

  const author = getText(document.querySelector(FFN_AUTHOR_SELECTOR));
  if (!author) {
    return {
      ok: false,
      code: "AUTHOR_NOT_FOUND",
      message: "Could not find the fanfiction.net story author on this page."
    };
  }

  const chapters = getChapters(document, location, storyPath);
  if (chapters.length === 0) {
    return {
      ok: false,
      code: "CHAPTERS_NOT_FOUND",
      message: "Could not find fanfiction.net story chapters on this page."
    };
  }

  return {
    ok: true,
    outputKind: "generated-story-pdf",
    site: "fanfiction-net",
    title,
    author,
    pageUrl: location.href,
    storyId: storyPath.storyId,
    folderSegments: [],
    skippedCount: 0,
    fileName: buildStoryPdfFileName(author, title),
    summary: getText(document.querySelector(FFN_SUMMARY_SELECTOR)),
    metadataLine: getText(document.querySelector(FFN_METADATA_SELECTOR)),
    chapters
  };
}

function parseStoryPath(location: Location): FanfictionStoryPath | null {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "s") {
    return null;
  }

  const chapter = Number.parseInt(parts[2], 10);
  if (!parts[1] || !Number.isFinite(chapter) || chapter < 1 || !parts[3]) {
    return null;
  }

  return {
    storyId: decodeURIComponent(parts[1]),
    chapter,
    slug: decodeURIComponent(parts[3])
  };
}

function getChapters(
  document: Document,
  location: Location,
  storyPath: FanfictionStoryPath
): StoryChapterReference[] {
  const select = document.querySelector<HTMLSelectElement>(FFN_CHAPTER_SELECTOR);
  const options = select ? Array.from(select.querySelectorAll<HTMLOptionElement>("option")) : [];

  if (options.length === 0) {
    return [
      {
        chapterNumber: storyPath.chapter,
        label: `Chapter ${storyPath.chapter}`,
        url: location.href
      }
    ];
  }

  const chapters: StoryChapterReference[] = [];
  const seenChapterNumbers = new Set<number>();

  for (const option of options) {
    const chapterNumber = Number.parseInt(option.value, 10);
    if (!Number.isFinite(chapterNumber) || chapterNumber < 1 || seenChapterNumbers.has(chapterNumber)) {
      continue;
    }

    seenChapterNumbers.add(chapterNumber);
    chapters.push({
      chapterNumber,
      label: collapseWhitespace(option.textContent || `Chapter ${chapterNumber}`),
      url: new URL(`/s/${storyPath.storyId}/${chapterNumber}/${encodeURIComponent(storyPath.slug)}`, location.href).toString()
    });
  }

  return chapters.sort((left, right) => left.chapterNumber - right.chapterNumber);
}

function getTitleFallback(document: Document): string {
  const title = document.title || "";
  const chapterIndex = title.search(/\s+Chapter\s+\d+/i);
  if (chapterIndex > 0) {
    return title.slice(0, chapterIndex).trim();
  }

  return title.replace(/\s*\|\s*FanFiction\s*$/i, "").trim();
}

function getText(element: Element | null): string {
  return collapseWhitespace(getElementText(element));
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
