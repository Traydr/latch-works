import type { PDFPageProxy } from "pdfjs-dist";
import { type JSX, useEffect, useRef, useState } from "react";

interface PdfViewerProps {
  initialPage?: number;
  mediaId: string;
  onPageChange?: (page: number) => void;
  title: string;
}

interface PageGeometry {
  height: number;
  width: number;
}

interface ActiveRender {
  cancel: () => void;
}

const MAX_PAGE_WIDTH_PX = 896;
const MAX_RETAINED_CANVASES = 8;
const PAGE_CHANGE_DEBOUNCE_MS = 3_000;
const PAGE_OVERSCAN = 2;

function getPageRenderWidth(container: HTMLElement): number {
  const width = container.clientWidth;
  if (width > 0) {
    return Math.min(width, MAX_PAGE_WIDTH_PX);
  }

  const parentWidth = container.parentElement?.clientWidth ?? window.innerWidth;
  return Math.min(Math.max(parentWidth - 24, 320), MAX_PAGE_WIDTH_PX);
}

export function getPdfPageRenderWindow(
  visiblePages: Iterable<number>,
  pageCount: number,
  fallbackPage = 1,
): number[] {
  const pages = [...visiblePages].filter((page) => page >= 1 && page <= pageCount);
  const first = pages.length > 0 ? Math.min(...pages) : Math.min(Math.max(fallbackPage, 1), pageCount);
  const last = pages.length > 0 ? Math.max(...pages) : first;
  const start = Math.max(1, first - PAGE_OVERSCAN);
  const end = Math.min(pageCount, Math.min(last + PAGE_OVERSCAN, start + MAX_RETAINED_CANVASES - 1));

  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function resolveVisiblePdfPage(entries: IntersectionObserverEntry[]): number | null {
  let bestPage: number | null = null;
  let bestRatio = 0;

  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }

    const pageValue = entry.target.getAttribute("data-page-number");
    const pageNumber = pageValue ? Number(pageValue) : Number.NaN;
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
      continue;
    }

    if (entry.intersectionRatio > bestRatio) {
      bestRatio = entry.intersectionRatio;
      bestPage = pageNumber;
    }
  }

  return bestPage;
}

export function scrollToPdfPage(container: HTMLElement, page: number): void {
  const target = container.querySelector<HTMLElement>(`[data-page-number="${page}"]`);
  target?.scrollIntoView({ block: "start" });
}

export function PdfViewer({
  initialPage,
  mediaId,
  onPageChange,
  title,
}: PdfViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const onPageChangeRef = useRef(onPageChange);
  const hasAppliedInitialPageRef = useRef(false);
  const previousMediaIdRef = useRef(mediaId);
  onPageChangeRef.current = onPageChange;

  useEffect(() => {
    if (previousMediaIdRef.current !== mediaId) {
      previousMediaIdRef.current = mediaId;
      hasAppliedInitialPageRef.current = false;
      setError(null);
      setPageCount(0);
    }
  }, [mediaId]);

  useEffect(() => {
    if (hasAppliedInitialPageRef.current || !initialPage || pageCount < 1) {
      return;
    }

    const container = containerRef.current;
    if (!container || initialPage > pageCount) {
      return;
    }

    scrollToPdfPage(container, initialPage);
    hasAppliedInitialPageRef.current = true;
  }, [initialPage, pageCount]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    let resizeObserver: ResizeObserver | undefined;
    let pageObserver: IntersectionObserver | undefined;
    let pageChangeTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyLoadingTask: (() => void) | undefined;
    let renderWidth = getPageRenderWidth(container);
    let renderVersion = 0;
    const visiblePages = new Set<number>();
    const renderTasks = new Map<number, ActiveRender>();
    container.replaceChildren();

    const reportPage = (page: number): void => {
      if (!onPageChangeRef.current) {
        return;
      }

      if (pageChangeTimer) {
        clearTimeout(pageChangeTimer);
      }

      pageChangeTimer = setTimeout(() => {
        onPageChangeRef.current?.(page);
      }, PAGE_CHANGE_DEBOUNCE_MS);
    };

    const cancelRender = (pageNumber: number): void => {
      renderTasks.get(pageNumber)?.cancel();
      renderTasks.delete(pageNumber);
      const slot = container.querySelector<HTMLElement>(`[data-page-number="${pageNumber}"]`);
      const canvas = slot?.querySelector("canvas");
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
      }
    };

    const render = async () => {
      try {
        const [pdfjs, workerModule] = await Promise.all([
          import("pdfjs-dist"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        if (cancelled) {
          return;
        }

        pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
        const loadingTask = pdfjs.getDocument({ url: `/api/media/${mediaId}/original` });
        destroyLoadingTask = () => loadingTask.destroy();
        const pdf = await loadingTask.promise;
        if (cancelled) {
          return;
        }

        const geometry = new Map<number, PageGeometry>();
        // A Rendition needs stable geometry before pages are painted so resume scrolling works.
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          geometry.set(pageNumber, { height: viewport.height, width: viewport.width });
          page.cleanup();
          if (cancelled) {
            return;
          }
        }

        const applyGeometry = () => {
          for (const [pageNumber, dimensions] of geometry) {
            const slot = container.querySelector<HTMLElement>(`[data-page-number="${pageNumber}"]`);
            if (slot) {
              slot.style.width = `${Math.floor(renderWidth)}px`;
              slot.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
            }
          }
        };

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const slot = document.createElement("div");
          slot.className = "mx-auto max-w-full overflow-hidden rounded bg-white";
          slot.dataset.pageNumber = String(pageNumber);
          container.append(slot);
        }
        applyGeometry();
        setPageCount(pdf.numPages);

        const paintWindow = (fallbackPage = initialPage ?? 1) => {
          const desiredPages = new Set(getPdfPageRenderWindow(visiblePages, pdf.numPages, fallbackPage));
          for (const pageNumber of [...renderTasks.keys()]) {
            if (!desiredPages.has(pageNumber)) {
              cancelRender(pageNumber);
            }
          }
          for (const canvas of container.querySelectorAll<HTMLCanvasElement>("canvas")) {
            const pageNumber = Number(canvas.parentElement?.dataset.pageNumber);
            if (!desiredPages.has(pageNumber)) {
              cancelRender(pageNumber);
            }
          }

          const version = renderVersion;
          for (const pageNumber of desiredPages) {
            const slot = container.querySelector<HTMLElement>(`[data-page-number="${pageNumber}"]`);
            if (!slot || slot.querySelector("canvas") || renderTasks.has(pageNumber)) {
              continue;
            }

            let task: ActiveRender | undefined;
            task = {
              cancel: () => {
                task = undefined;
              },
            };
            renderTasks.set(pageNumber, task);
            void (async () => {
              let page: PDFPageProxy | undefined;
              let renderTask: ReturnType<PDFPageProxy["render"]> | undefined;
              try {
                page = await pdf.getPage(pageNumber);
                if (cancelled || task !== renderTasks.get(pageNumber) || version !== renderVersion) {
                  return;
                }

                const dimensions = geometry.get(pageNumber);
                if (!dimensions) {
                  return;
                }
                const scale = renderWidth / dimensions.width;
                const viewport = page.getViewport({ scale });
                const canvas = document.createElement("canvas");
                const outputScale = window.devicePixelRatio || 1;
                canvas.width = Math.floor(viewport.width * outputScale);
                canvas.height = Math.floor(viewport.height * outputScale);
                canvas.className = "block h-full w-full";
                const context = canvas.getContext("2d");
                if (!context) {
                  return;
                }

                renderTask = page.render({
                  canvas,
                  canvasContext: context,
                  transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
                  viewport,
                });
                task.cancel = () => renderTask?.cancel();
                await renderTask.promise;
                if (!cancelled && task === renderTasks.get(pageNumber) && version === renderVersion) {
                  slot.replaceChildren(canvas);
                }
              } catch {
                // Cancelled and failed page paints leave their geometry placeholder in place.
              } finally {
                page?.cleanup();
                if (task === renderTasks.get(pageNumber)) {
                  renderTasks.delete(pageNumber);
                }
              }
            })();
          }
        };

        pageObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const pageNumber = Number(entry.target.getAttribute("data-page-number"));
              if (!Number.isFinite(pageNumber)) {
                continue;
              }
              if (entry.isIntersecting) {
                visiblePages.add(pageNumber);
              } else {
                visiblePages.delete(pageNumber);
              }
            }
            const visiblePage = resolveVisiblePdfPage(entries);
            if (visiblePage) {
              reportPage(visiblePage);
            }
            paintWindow(visiblePage ?? initialPage ?? 1);
          },
          { root: scrollContainerRef.current, threshold: [0, 0.25, 0.5, 0.75, 1] },
        );
        for (const slot of container.querySelectorAll("[data-page-number]")) {
          pageObserver.observe(slot);
        }
        paintWindow();

        resizeObserver = new ResizeObserver(() => {
          const nextRenderWidth = getPageRenderWidth(container);
          if (Math.abs(nextRenderWidth - renderWidth) < 8) {
            return;
          }
          renderWidth = nextRenderWidth;
          renderVersion += 1;
          applyGeometry();
          for (const pageNumber of [...renderTasks.keys()]) {
            cancelRender(pageNumber);
          }
          for (const canvas of container.querySelectorAll<HTMLCanvasElement>("canvas")) {
            cancelRender(Number(canvas.parentElement?.dataset.pageNumber));
          }
          paintWindow();
        });
        resizeObserver.observe(container);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load PDF");
        }
      }
    };

    void render();
    return () => {
      cancelled = true;
      renderVersion += 1;
      destroyLoadingTask?.();
      for (const task of renderTasks.values()) {
        task.cancel();
      }
      resizeObserver?.disconnect();
      pageObserver?.disconnect();
      if (pageChangeTimer) {
        clearTimeout(pageChangeTimer);
      }
    };
  }, [mediaId]);

  return (
    <div ref={scrollContainerRef} className="h-full w-full overflow-auto px-3 py-2">
      {error ? (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {pageCount > 0 ? (
        <p className="mb-3 text-center text-xs text-zinc-400">
          {title} · {pageCount} pages
        </p>
      ) : null}
      <div ref={containerRef} className="flex flex-col gap-4" />
    </div>
  );
}
