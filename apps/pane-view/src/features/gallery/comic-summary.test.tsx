// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserEntryCard } from "@/features/gallery/BrowserEntryCard";
import {
  createMemoryGalleryPageSource,
  memorySourceKey,
} from "@/features/gallery/gallery-page-source.memory";
import {
  comicSummary,
  listingRequest,
  mediaItem,
  renderSession,
  type SessionHarness,
} from "@/features/gallery/gallery-session-harness";

/**
 * Comic cards render from summaries alone and the reader loads the complete
 * comic on demand through the session (Plan 052 Step 2, Decision 9).
 */

let harness: SessionHarness | null = null;

/** jsdom has no matchMedia; the cards only ask whether this is a phone. */
function stubMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    })),
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubMatchMedia();
});

afterEach(() => {
  harness?.unmount();
  harness = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("comic summary card", () => {
  it("renders name, page count, and the cover from a summary with no pages array", () => {
    const summary = comicSummary("photos/series/vol-1", 42);
    expect(summary).not.toHaveProperty("pages");
    const container = document.createElement("div");
    document.body.append(container);
    let root: Root | undefined;
    act(() => {
      root = createRoot(container);
      root.render(
        createElement(BrowserEntryCard, {
          cardHeight: 300,
          cardWidth: 200,
          deletedEntryIds: new Set<string>(),
          deletingEntryIds: new Set([summary.cover.id]),
          entry: { comic: summary, key: `comic:${summary.id}`, kind: "comic" },
          focused: false,
          left: 0,
          onActivate: vi.fn(),
          onSelect: vi.fn(),
          selected: false,
          thumbnailUrls: {},
          top: 0,
        }),
      );
    });
    expect(container.textContent).toContain("vol-1");
    expect(container.textContent).toContain("42 pages");
    // Overlays follow the cover id: the deleting cover shows the animated overlay.
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    act(() => root?.unmount());
  });

  it("shows the opening affordance while the full comic loads", () => {
    const summary = comicSummary("photos/series/vol-2", 7);
    const container = document.createElement("div");
    document.body.append(container);
    let root: Root | undefined;
    act(() => {
      root = createRoot(container);
      root.render(
        createElement(BrowserEntryCard, {
          cardHeight: 300,
          cardWidth: 200,
          deletedEntryIds: new Set<string>(),
          deletingEntryIds: new Set<string>(),
          entry: { comic: summary, key: `comic:${summary.id}`, kind: "comic" },
          focused: false,
          left: 0,
          onActivate: vi.fn(),
          onSelect: vi.fn(),
          opening: true,
          selected: false,
          thumbnailUrls: {},
          top: 0,
        }),
      );
    });
    expect(container.textContent).toContain("Opening…");
    expect(container.textContent).not.toContain("7 pages");
    act(() => root?.unmount());
  });
});

describe("session.openComic", () => {
  it("loads the complete comic once through the port and serves the second activation from cache", async () => {
    const request = listingRequest({
      comicMode: true,
      limit: 5,
      recursive: true,
      showVideos: false,
    });
    const summary = comicSummary("photos/series/vol-1", 90);
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: { comics: [summary] },
    });
    const [firstPage, ...morePages] = Array.from({ length: 90 }, (_, index) =>
      mediaItem(`vol-1-p${index}`, { parentPath: summary.folderPath }),
    );
    if (!firstPage) throw new Error("expected comic pages");
    const pages = [firstPage, ...morePages];
    source.comics.set(summary.id, {
      cover: firstPage,
      folderPath: summary.folderPath,
      id: summary.id,
      name: summary.name,
      pages,
    });
    harness = await renderSession({ request, source });
    expect(harness.session.entries).toHaveLength(1);

    let comic: Awaited<ReturnType<typeof harness.session.openComic>> | undefined;
    await act(async () => {
      comic = await harness?.session.openComic(summary.id);
    });
    expect(comic?.pages.map((page) => page.id)).toEqual(pages.map((page) => page.id));
    expect(source.calls.comic).toEqual([
      {
        comicId: summary.id,
        path: "photos",
        query: undefined,
        showImages: true,
        showVideos: false,
      },
    ]);

    await act(async () => {
      comic = await harness?.session.openComic(summary.id);
    });
    expect(comic?.pages).toHaveLength(90);
    expect(source.calls.comic).toHaveLength(1);
  });
});
