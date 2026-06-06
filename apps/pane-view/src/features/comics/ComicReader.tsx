import type { ComicEntry } from "@latch-works/media-domain";
import { type JSX, useEffect, useRef, useState } from "react";

interface ComicReaderProps {
  comic: ComicEntry;
  onClose: () => void;
}

export function ComicReader({ comic, onClose }: ComicReaderProps): JSX.Element {
  const readerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Array<HTMLImageElement | null>>([]);
  const currentPageIndexRef = useRef(0);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  const setCurrentPage = (index: number): void => {
    currentPageIndexRef.current = index;
    setCurrentPageIndex(index);
  };

  useEffect(() => {
    pageRefs.current = [];
    setCurrentPage(0);
    readerRef.current?.scrollTo({ top: 0 });
  }, [comic]);

  useEffect(() => {
    const scrollToPage = (index: number): void => {
      const nextIndex = Math.max(0, Math.min(comic.pages.length - 1, index));
      setCurrentPage(nextIndex);

      window.requestAnimationFrame(() => {
        const page = pageRefs.current[nextIndex];
        page?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    };

    const keyListener = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key === "ArrowRight" || event.key.toLowerCase() === "e") {
        event.preventDefault();
        scrollToPage(currentPageIndexRef.current + 1);
        return;
      }

      if (event.key === "ArrowLeft" || event.key.toLowerCase() === "q") {
        event.preventDefault();
        scrollToPage(currentPageIndexRef.current - 1);
      }
    };

    window.addEventListener("keydown", keyListener);
    return () => window.removeEventListener("keydown", keyListener);
  }, [comic.pages.length, onClose]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) {
      return undefined;
    }

    let frameId: number | null = null;
    const syncCurrentPage = (): void => {
      frameId = null;
      let nearestIndex = currentPageIndexRef.current;
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (let index = 0; index < pageRefs.current.length; index += 1) {
        const page = pageRefs.current[index];
        if (!page) {
          continue;
        }

        const distance = Math.abs(page.offsetTop - reader.scrollTop);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      }

      setCurrentPage(nearestIndex);
    };

    const onScroll = (): void => {
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(syncCurrentPage);
    };

    reader.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      reader.removeEventListener("scroll", onScroll);
    };
  }, []);

  const scrollToTop = (): void => {
    readerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950 text-zinc-100">
      <div className="pointer-events-none absolute left-1/2 top-4 z-20 w-[min(94vw,980px)] -translate-x-1/2">
        <div className="pointer-events-auto flex items-center justify-between gap-3 rounded-2xl border border-zinc-700/80 bg-zinc-900/90 px-4 py-3 shadow-xl backdrop-blur-xl">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">{comic.name}</p>
            <p className="text-xs text-zinc-300">
              {currentPageIndex + 1}/{comic.pages.length} pages
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button type="button" className="rounded-xl border border-zinc-700 px-3 py-1.5 text-xs" onClick={scrollToTop}>
              Top
            </button>
            <button type="button" className="rounded-xl border border-zinc-700 px-3 py-1.5 text-xs" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>

      <div ref={readerRef} className="h-full overflow-auto px-3 pb-12 pt-24">
        <div className="mx-auto flex w-[min(100%,980px)] flex-col items-center gap-3">
          {comic.pages.map((page, index) => (
            <img
              key={page.id}
              ref={(element) => {
                pageRefs.current[index] = element;
              }}
              src={`/api/media/${page.id}/preview`}
              alt={page.name}
              loading="lazy"
              decoding="async"
              onError={(event) => {
                const image = event.currentTarget;
                const originalSrc = `/api/media/${page.id}/original`;
                if (image.src !== new URL(originalSrc, window.location.origin).href) {
                  image.src = originalSrc;
                }
              }}
              className="max-h-none w-full max-w-full rounded bg-zinc-900 object-contain"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
