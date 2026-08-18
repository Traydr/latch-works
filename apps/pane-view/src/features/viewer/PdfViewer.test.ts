// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

interface PdfViewerMocks {
  documents: FakeDocument[];
  intersectionObservers: FakeIntersectionObserver[];
  resizeObservers: FakeResizeObserver[];
  renderTasks: FakeRenderTask[];
  scrollIntoView: Mock;
}

const mocks = vi.hoisted(
  (): PdfViewerMocks => ({
    documents: [],
    intersectionObservers: [],
    resizeObservers: [],
    renderTasks: [],
    scrollIntoView: vi.fn(),
  }),
);

import { PdfViewer } from "./PdfViewer";
import type { PdfEngine } from "./pdf-engine";
import {
  getPdfPageRenderWindow,
  type PdfPageIntersection,
  resolveVisiblePdfPage,
  scrollToPdfPage,
} from "./pdf-viewer-helpers";

/** Stands in for the pdf.js adapter; each mount takes the next queued document. */
let openDocument = vi.fn<PdfEngine["openDocument"]>();
let engine: PdfEngine = { openDocument };

function installFakeEngine(): void {
  openDocument = vi.fn<PdfEngine["openDocument"]>(async () => {
    const next = mocks.documents.shift();
    if (!next) {
      throw new Error("no fake PDF document was queued");
    }
    return next;
  });
  engine = { openDocument };
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: Error) => void;
  resolve: (value: T) => void;
}

interface FakeRenderTask {
  cancel: Mock;
  pageNumber: number;
  reject: (reason: Error) => void;
  resolve: () => void;
}

interface FakeDocument {
  destroy: Mock;
  getPage: Mock;
  numPages: number;
  promise: Promise<FakeDocument>;
}

/**
 * Stand-in for the browser IntersectionObserver, installed with
 * vi.stubGlobal. The viewer's callback reads only the PdfPageIntersection
 * fields, so that is what `emit` delivers.
 */
class FakeIntersectionObserver {
  readonly disconnect = vi.fn();
  readonly observed = new Set<Element>();

  constructor(private readonly callback: (entries: PdfPageIntersection[]) => void) {
    mocks.intersectionObservers.push(this);
  }

  observe = (element: Element): void => {
    this.observed.add(element);
  };

  unobserve = vi.fn();

  emit(pages: Array<[number, number, boolean]>): void {
    this.callback(
      pages.flatMap(([pageNumber, intersectionRatio, isIntersecting]) => {
        const target = [...this.observed].find(
          (element) => element.getAttribute("data-page-number") === String(pageNumber),
        );
        return target ? [{ intersectionRatio, isIntersecting, target }] : [];
      }),
    );
  }
}

/** Stand-in for ResizeObserver; the viewer's callback ignores its arguments. */
class FakeResizeObserver {
  readonly disconnect = vi.fn();
  readonly observed = new Set<Element>();

  constructor(private readonly callback: () => void) {
    mocks.resizeObservers.push(this);
  }

  observe = (element: Element): void => {
    this.observed.add(element);
  };

  emit(): void {
    this.callback();
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function fakeDocument(
  pageCount: number,
  pendingPages = new Set<number>(),
  rejectedPages = new Set<number>(),
): FakeDocument {
  // pdfjs resolves the loading task with the document itself.
  let resolveDocument!: (document: FakeDocument) => void;
  const document: FakeDocument = {
    destroy: vi.fn(),
    getPage: vi.fn(async (pageNumber: number) => ({
      cleanup: vi.fn(),
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        height: 1400 * scale,
        width: 1000 * scale,
      })),
      render: vi.fn(() => {
        const task = deferred<void>();
        const renderTask: FakeRenderTask = {
          cancel: vi.fn(),
          pageNumber,
          reject: task.reject,
          resolve: () => task.resolve(),
        };
        mocks.renderTasks.push(renderTask);
        if (rejectedPages.has(pageNumber)) {
          task.reject(new Error("render failed"));
        } else if (!pendingPages.has(pageNumber)) {
          task.resolve();
        }
        return { cancel: renderTask.cancel, promise: task.promise };
      }),
    })),
    numPages: pageCount,
    promise: new Promise<FakeDocument>((resolve) => {
      resolveDocument = resolve;
    }),
  };
  resolveDocument(document);
  return document;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 100; index += 1) {
      await Promise.resolve();
    }
  });
}

function mount(
  props: { initialPage?: number; mediaId?: string; onPageChange?: (page: number) => void } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;
  const render = (nextProps = props) => {
    act(() => {
      root.render(
        createElement(PdfViewer, {
          engine,
          initialPage: nextProps.initialPage,
          mediaId: nextProps.mediaId ?? "media-a",
          onPageChange: nextProps.onPageChange,
          title: "Test PDF",
        }),
      );
    });
  };
  act(() => {
    root = createRoot(container);
  });
  render();
  return {
    container,
    rerender: render,
    unmount: () => act(() => root.unmount()),
  };
}

function slots(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-page-number]")];
}

describe("getPdfPageRenderWindow", () => {
  it("keeps every observed visible page when there is capacity", () => {
    expect(getPdfPageRenderWindow([1, 10], 300, 1)).toEqual([1, 2, 3, 10]);
  });

  it("uses the focal page as deterministic priority when visible pages exceed capacity", () => {
    expect(getPdfPageRenderWindow([1, 2, 3, 4, 5, 6, 7, 8, 9], 300, 9)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
});

describe("PdfViewer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.documents.length = 0;
    mocks.intersectionObservers.length = 0;
    mocks.resizeObservers.length = 0;
    mocks.renderTasks.length = 0;
    mocks.scrollIntoView.mockReset();
    installFakeEngine();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    // SAFETY: jsdom has no canvas; the fake page.render never touches the
    // context, it only needs to be non-null so rendering is attempted.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
    Element.prototype.scrollIntoView = mocks.scrollIntoView;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("creates geometry for 300 pages while initially painting only the bounded window", async () => {
    const pdf = fakeDocument(300);
    mocks.documents.push(pdf);
    const viewer = mount();

    await flush();

    expect(slots(viewer.container)).toHaveLength(300);
    expect(pdf.getPage).toHaveBeenCalledTimes(303);
    expect(mocks.renderTasks.map((task) => task.pageNumber)).toEqual([1, 2, 3]);
    viewer.unmount();
  });

  it("renders the next observer window and retains no more than eight canvases", async () => {
    mocks.documents.push(fakeDocument(300));
    const viewer = mount();
    await flush();

    mocks.intersectionObservers[0]?.emit([
      [1, 0, false],
      [10, 1, true],
    ]);
    await flush();

    expect(mocks.renderTasks.map((task) => task.pageNumber)).toEqual([1, 2, 3, 8, 9, 10, 11, 12]);
    expect(viewer.container.querySelectorAll("canvas").length).toBeLessThanOrEqual(8);
    expect(
      [...viewer.container.querySelectorAll("canvas")].map(
        (canvas) => canvas.parentElement?.dataset.pageNumber,
      ),
    ).toEqual(["8", "9", "10", "11", "12"]);
    viewer.unmount();
  });

  it("repaints only the active window on resize and ignores stale completion", async () => {
    const pdf = fakeDocument(300, new Set([1, 2, 3]));
    mocks.documents.push(pdf);
    const viewer = mount();
    await flush();
    const resizeTarget = [...(mocks.resizeObservers[0]?.observed ?? [])][0];
    if (!resizeTarget) throw new Error("expected the viewer to observe its container");
    Object.defineProperty(resizeTarget, "clientWidth", { configurable: true, value: 600 });

    mocks.resizeObservers[0]?.emit();
    await flush();

    expect(mocks.renderTasks.slice(0, 3).every((task) => task.cancel.mock.calls.length === 1)).toBe(
      true,
    );
    expect(mocks.renderTasks.slice(3).map((task) => task.pageNumber)).toEqual([1, 2, 3]);
    mocks.renderTasks[0]?.resolve();
    await flush();
    expect(slots(viewer.container)[0]?.querySelector("canvas")).toBeNull();
    mocks.renderTasks[3]?.resolve();
    await flush();
    expect(slots(viewer.container)[0]?.querySelector("canvas")).not.toBeNull();
    viewer.unmount();
  });

  it("restores the initial page and suppresses rejected render task errors", async () => {
    mocks.documents.push(fakeDocument(20, new Set(), new Set([18])));
    const viewer = mount({ initialPage: 18 });
    await flush();

    expect(mocks.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(mocks.renderTasks.map((task) => task.pageNumber)).toEqual([16, 17, 18, 19, 20]);
    expect(slots(viewer.container)[17]?.querySelector("canvas")).toBeNull();
    viewer.unmount();
  });

  it("destroys loading work and cancels renders, observers, and reporting on media change and unmount", async () => {
    const firstPdf = fakeDocument(20, new Set([1, 2, 3]));
    const secondPdf = fakeDocument(20, new Set([1, 2, 3]));
    mocks.documents.push(firstPdf, secondPdf);
    const onPageChange = vi.fn();
    const viewer = mount({ onPageChange });
    await flush();
    mocks.intersectionObservers[0]?.emit([[1, 1, true]]);
    await flush();

    viewer.rerender({ mediaId: "media-b", onPageChange });
    await flush();
    expect(firstPdf.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.intersectionObservers[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.resizeObservers[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.renderTasks.slice(0, 3).every((task) => task.cancel.mock.calls.length === 1)).toBe(
      true,
    );

    viewer.unmount();
    expect(secondPdf.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.intersectionObservers[1]?.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.resizeObservers[1]?.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reload the document when a late resume page arrives for the same media", async () => {
    const pdf = fakeDocument(20, new Set([1, 2, 3]));
    mocks.documents.push(pdf);
    const viewer = mount({ mediaId: "media-a" });
    await flush();
    expect(openDocument).toHaveBeenCalledTimes(1);

    viewer.rerender({ mediaId: "media-a", initialPage: 12 });
    await flush();

    expect(pdf.destroy).not.toHaveBeenCalled();
    expect(openDocument).toHaveBeenCalledTimes(1);
    expect(mocks.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    viewer.unmount();
  });
});

describe("resolveVisiblePdfPage", () => {
  it("returns the page with the highest intersection ratio", () => {
    const pageOne = document.createElement("div");
    pageOne.dataset.pageNumber = "1";
    const pageTwo = document.createElement("div");
    pageTwo.dataset.pageNumber = "2";
    expect(
      resolveVisiblePdfPage([
        { intersectionRatio: 0.2, isIntersecting: true, target: pageOne },
        { intersectionRatio: 0.8, isIntersecting: true, target: pageTwo },
      ]),
    ).toBe(2);
  });
});

describe("scrollToPdfPage", () => {
  it("scrolls the requested page into view", () => {
    const container = document.createElement("div");
    const page = document.createElement("div");
    page.dataset.pageNumber = "2";
    page.scrollIntoView = vi.fn();
    container.append(page);
    scrollToPdfPage(container, 2);
    expect(page.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });
});
