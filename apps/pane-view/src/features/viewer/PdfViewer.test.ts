// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { getPdfPageRenderWindow, resolveVisiblePdfPage, scrollToPdfPage } from "./PdfViewer";

describe("getPdfPageRenderWindow", () => {
  it("bounds initial painting for a 300-page Rendition", () => {
    expect(getPdfPageRenderWindow([], 300)).toEqual([1, 2, 3]);
    expect(getPdfPageRenderWindow([], 300, 298)).toEqual([296, 297, 298, 299, 300]);
  });

  it("includes visible pages and overscan without retaining more than eight canvases", () => {
    const pages = getPdfPageRenderWindow([100, 101], 300);

    expect(pages).toEqual([98, 99, 100, 101, 102, 103]);
    expect(pages).toHaveLength(6);
    expect(getPdfPageRenderWindow([1, 10], 300)).toHaveLength(8);
  });

  it("clamps the window at document boundaries", () => {
    expect(getPdfPageRenderWindow([1], 1)).toEqual([1]);
    expect(getPdfPageRenderWindow([300], 300)).toEqual([298, 299, 300]);
  });
});

describe("resolveVisiblePdfPage", () => {
  it("returns the page with the highest intersection ratio", () => {
    const pageOne = document.createElement("canvas");
    pageOne.dataset.pageNumber = "1";
    const pageTwo = document.createElement("canvas");
    pageTwo.dataset.pageNumber = "2";

    const page = resolveVisiblePdfPage([
      {
        intersectionRatio: 0.2,
        isIntersecting: true,
        target: pageOne,
      } as unknown as IntersectionObserverEntry,
      {
        intersectionRatio: 0.8,
        isIntersecting: true,
        target: pageTwo,
      } as unknown as IntersectionObserverEntry,
    ]);

    expect(page).toBe(2);
  });

  it("ignores non-intersecting entries", () => {
    const pageOne = document.createElement("canvas");
    pageOne.dataset.pageNumber = "1";

    const page = resolveVisiblePdfPage([
      {
        intersectionRatio: 0,
        isIntersecting: false,
        target: pageOne,
      } as unknown as IntersectionObserverEntry,
    ]);

    expect(page).toBeNull();
  });
});

describe("scrollToPdfPage", () => {
  it("scrolls the requested page into view", () => {
    const container = document.createElement("div");
    const pageOne = document.createElement("canvas");
    pageOne.dataset.pageNumber = "1";
    const pageTwo = document.createElement("canvas");
    pageTwo.dataset.pageNumber = "2";
    pageTwo.scrollIntoView = vi.fn();
    container.append(pageOne, pageTwo);

    scrollToPdfPage(container, 2);

    expect(pageTwo.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });
});
