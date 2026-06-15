import type { PDFPageProxy } from "pdfjs-dist";
import { type JSX, useEffect, useRef, useState } from "react";

interface PdfViewerProps {
  initialPage?: number;
  mediaId: string;
  onPageChange?: (page: number) => void;
  title: string;
}

const MAX_PAGE_WIDTH_PX = 896;
const PAGE_CHANGE_DEBOUNCE_MS = 3_000;

function getPageRenderWidth(container: HTMLElement): number {
  const width = container.clientWidth;
  if (width > 0) {
    return Math.min(width, MAX_PAGE_WIDTH_PX);
  }

  const parentWidth = container.parentElement?.clientWidth ?? window.innerWidth;
  return Math.min(Math.max(parentWidth - 24, 320), MAX_PAGE_WIDTH_PX);
}

async function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  renderWidth: number,
): Promise<void> {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = renderWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const outputScale = window.devicePixelRatio || 1;

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

  await page.render({ canvas, canvasContext: context, transform, viewport }).promise;
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
  onPageChangeRef.current = onPageChange;

  useEffect(() => {
    hasAppliedInitialPageRef.current = false;
  }, [mediaId]);

  useEffect(() => {
    if (hasAppliedInitialPageRef.current || !initialPage || pageCount < 1) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (initialPage > pageCount) {
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
        const pdf = await loadingTask.promise;
        if (cancelled) {
          return;
        }

        setPageCount(pdf.numPages);

        const paintPages = async () => {
          if (cancelled) {
            return;
          }

          const scrollContainer = scrollContainerRef.current;
          const previousScrollTop = scrollContainer?.scrollTop ?? 0;
          const renderWidth = getPageRenderWidth(container);
          container.replaceChildren();
          pageObserver?.disconnect();

          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            if (cancelled) {
              return;
            }

            const page = await pdf.getPage(pageNumber);
            const canvas = document.createElement("canvas");
            canvas.className = "mx-auto max-w-full rounded bg-white";
            canvas.dataset.pageNumber = String(pageNumber);

            await renderPageToCanvas(page, canvas, renderWidth);
            container.append(canvas);
          }

          if (scrollContainer) {
            scrollContainer.scrollTop = previousScrollTop;
          }

          if (onPageChangeRef.current) {
            pageObserver = new IntersectionObserver(
              (entries) => {
                const visiblePage = resolveVisiblePdfPage(entries);
                if (visiblePage) {
                  reportPage(visiblePage);
                }
              },
              {
                root: scrollContainerRef.current,
                threshold: [0, 0.25, 0.5, 0.75, 1],
              },
            );

            for (const canvas of container.querySelectorAll("[data-page-number]")) {
              pageObserver.observe(canvas);
            }
          }
        };

        if (container.clientWidth === 0) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }

        await paintPages();

        let lastRenderWidth = getPageRenderWidth(container);
        resizeObserver = new ResizeObserver(() => {
          const nextRenderWidth = getPageRenderWidth(container);
          if (Math.abs(nextRenderWidth - lastRenderWidth) < 8) {
            return;
          }

          lastRenderWidth = nextRenderWidth;
          void paintPages();
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
