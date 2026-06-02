import { type JSX, useEffect, useRef, useState } from 'react';

import type { ComicEntry } from '../utils/comics';
import { HOTKEYS, isPlainHotkeyEvent, matchesAnyKey } from '../utils/hotkeys';
import { toFileUrl } from '../utils/path';

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
        if (!page) {
          return;
        }

        page.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    };

    const keyListener = (event: KeyboardEvent): void => {
      if (matchesAnyKey(event, HOTKEYS.close)) {
        onClose();
        return;
      }

      if (!isPlainHotkeyEvent(event)) {
        return;
      }

      if (matchesAnyKey(event, HOTKEYS.viewerNext)) {
        event.preventDefault();
        scrollToPage(currentPageIndexRef.current + 1);
        return;
      }

      if (matchesAnyKey(event, HOTKEYS.viewerPrevious)) {
        event.preventDefault();
        scrollToPage(currentPageIndexRef.current - 1);
      }
    };

    window.addEventListener('keydown', keyListener);
    return () => window.removeEventListener('keydown', keyListener);
  }, [comic.pages.length, onClose]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) {
      return undefined;
    }

    let frameId: number | null = null;
    const syncCurrentPage = (): void => {
      frameId = null;
      let nearestIndex = currentPageIndex;
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

    reader.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      reader.removeEventListener('scroll', onScroll);
    };
  }, [currentPageIndex]);

  const scrollToTop = (): void => {
    readerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="dark fixed inset-0 z-50 bg-zinc-950 text-zinc-100">
      <div className="pointer-events-none absolute left-1/2 top-4 z-20 w-[min(94vw,980px)] -translate-x-1/2">
        <div className="prism-surface pointer-events-auto flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">{comic.name}</p>
            <p className="text-xs text-zinc-300">
              {currentPageIndex + 1}/{comic.pages.length} pages
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              className="prism-btn"
              onClick={() => void window.frameView.revealInFolder(comic.cover.path)}
            >
              Reveal
            </button>
            <button type="button" className="prism-btn" onClick={scrollToTop}>
              Top
            </button>
            <button type="button" className="prism-btn" onClick={onClose}>
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
              src={toFileUrl(page.path)}
              alt={page.name}
              loading="lazy"
              decoding="async"
              className="max-h-none w-full max-w-full rounded bg-zinc-900 object-contain"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
