// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeneratedStoryPayload } from "../shared/types";
import { extractStoryBlocks, fetchChapterContents } from "./fanfiction-story";

const payload: GeneratedStoryPayload = {
  ok: true,
  outputKind: "generated-story-pdf",
  site: "fanfiction-net",
  title: "A Test Story",
  author: "Writer",
  pageUrl: "https://www.fanfiction.net/s/1/1/Test",
  storyId: "1",
  folderSegments: [],
  skippedCount: 0,
  fileName: "Writer-A_Test_Story.pdf",
  summary: "Summary",
  metadataLine: "Rated T",
  chapters: [{ chapterNumber: 1, label: "Chapter 1", url: "https://example.test/chapter-1" }]
};

afterEach(() => vi.unstubAllGlobals());

describe("generated-story output adapter", () => {
  it("normalizes story markup while preserving bold and italic runs", () => {
    const document = new DOMParser().parseFromString(
      '<div id="storytext"><p>  Hello <strong>bold <em>and italic</em></strong> world. </p><br></div>',
      "text/html"
    );

    expect(extractStoryBlocks(document.querySelector("#storytext")!)).toEqual([
      {
        kind: "paragraph",
        runs: [
          { text: "Hello ", bold: false, italic: false },
          { text: "bold ", bold: true, italic: false },
          { text: "and italic", bold: true, italic: true },
          { text: " world.", bold: false, italic: false }
        ]
      },
      { kind: "blank", runs: [] }
    ]);
  });

  it("reports the exact chapter whose fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(
      fetchChapterContents(payload, {
        onStart: vi.fn(),
        onChapterFetched: vi.fn(),
        onGenerating: vi.fn(),
        onSaved: vi.fn()
      })
    ).rejects.toThrow("Failed Chapter 1: HTTP 503");
  });

  it("rejects a chapter response without story text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "<main>missing story</main>" })
    );

    await expect(
      fetchChapterContents(payload, {
        onStart: vi.fn(),
        onChapterFetched: vi.fn(),
        onGenerating: vi.fn(),
        onSaved: vi.fn()
      })
    ).rejects.toThrow("Failed Chapter 1: story text was not found.");
  });
});
