// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { resolveVisiblePdfPage, scrollToPdfPage } from "./PdfViewer";

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
