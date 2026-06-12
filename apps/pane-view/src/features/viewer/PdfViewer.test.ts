// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { resolveVisiblePdfPage } from "./PdfViewer";

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
