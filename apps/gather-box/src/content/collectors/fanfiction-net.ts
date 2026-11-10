import { buildStoryPdfFileName } from "../../shared/path";
import type { CollectorResult, StoryChapterReference } from "../../shared/types";
import type { PageLocation, SourcePage } from "../collector-entry";

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

export function collect(document: Document, page: SourcePage): CollectorResult {
  const storyPath = parseStoryPath(page);

  if (!storyPath) {
    return { ok: false, message: "This fanfiction.net page is not a supported story URL." };
  }

  const title = getText(document.querySelector(FFN_TITLE_SELECTOR)) || getTitleFallback(document);

  if (!title) {
    return {
      ok: false,
      message: "Could not find the fanfiction.net story title on this page.",
    };
  }

  const author = getText(document.querySelector(FFN_AUTHOR_SELECTOR));

  if (!author) {
    return {
      ok: false,
      message: "Could not find the fanfiction.net story author on this page.",
    };
  }

  const chapters = getChapters(document, page.location, storyPath);

  if (chapters.length === 0) {
    return {
      ok: false,
      message: "Could not find fanfiction.net story chapters on this page.",
    };
  }

  return {
    ok: true,
    outputKind: "generated-story-pdf",
    title,
    author,
    storyId: storyPath.storyId,
    folderSegments: [],
    fileName: buildStoryPdfFileName(author, title),
    summary: getText(document.querySelector(FFN_SUMMARY_SELECTOR)),
    metadataLine: getText(document.querySelector(FFN_METADATA_SELECTOR)),
    chapters,
  };
}

function parseStoryPath(page: SourcePage): FanfictionStoryPath | null {
  const { storyId, chapter, slug } = page.address;
  const chapterNumber = Number.parseInt(chapter ?? "", 10);

  if (!storyId || !slug || !Number.isFinite(chapterNumber) || chapterNumber < 1) {
    return null;
  }

  return {
    storyId: decodeURIComponent(storyId),
    chapter: chapterNumber,
    slug: decodeURIComponent(slug),
  };
}

function getChapters(
  document: Document,
  location: PageLocation,
  storyPath: FanfictionStoryPath,
): StoryChapterReference[] {
  const select = document.querySelector<HTMLSelectElement>(FFN_CHAPTER_SELECTOR);
  const options = select ? Array.from(select.querySelectorAll<HTMLOptionElement>("option")) : [];

  if (options.length === 0) {
    return [
      {
        chapterNumber: storyPath.chapter,
        label: `Chapter ${storyPath.chapter}`,
        url: location.href,
      },
    ];
  }

  const chapters: StoryChapterReference[] = [];
  const seenChapterNumbers = new Set<number>();

  for (const option of options) {
    const chapterNumber = Number.parseInt(option.value, 10);

    if (
      !Number.isFinite(chapterNumber) ||
      chapterNumber < 1 ||
      seenChapterNumbers.has(chapterNumber)
    ) {
      continue;
    }

    seenChapterNumbers.add(chapterNumber);
    chapters.push({
      chapterNumber,
      label: collapseWhitespace(option.textContent || `Chapter ${chapterNumber}`),
      url: new URL(
        `/s/${storyPath.storyId}/${chapterNumber}/${encodeURIComponent(storyPath.slug)}`,
        location.href,
      ).toString(),
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
  return collapseWhitespace(element?.textContent || "");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
