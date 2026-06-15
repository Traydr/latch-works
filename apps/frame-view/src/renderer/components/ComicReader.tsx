import { ArrowUp, FolderOpen, X } from 'lucide-react';
import { type JSX, useEffect, useRef, useState } from 'react';

import { useViewerChromeIdle } from '../hooks/useViewerChromeIdle';
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
  const { chromeVisible, revealChrome, chromeVisibilityClass } = useViewerChromeIdle();

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
      revealChrome();

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
  }, [comic.pages.length, onClose, revealChrome]);

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
      revealChrome();
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
  }, [currentPageIndex, revealChrome]);

  const scrollToTop = (): void => {
    readerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Comic reader for ${comic.name}`}
      className={`dark fixed inset-0 z-50 bg-zinc-950 text-zinc-100 ${chromeVisible ? '' : 'cursor-none'}`}
      onMouseMove={revealChrome}
      onPointerDown={revealChrome}
    >
      {/* Top-left title label */}
      <div
        className={`viewer-scrim-top viewer-chrome-transition ${chromeVisibilityClass}`}
        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
      >
        <div className="pointer-events-auto min-w-0 max-w-[min(70vw,640px)]">
          <p className="truncate text-sm font-medium text-white">{comic.name}</p>
          <p className="text-xs text-white/70">
            {currentPageIndex + 1}/{comic.pages.length} pages
          </p>
        </div>
      </div>

      {/* Right-side action rail */}
      <div
        className={`pointer-events-none absolute right-3 top-1/2 z-20 -translate-y-1/2 viewer-chrome-transition ${chromeVisibilityClass}`}
        style={{ paddingRight: 'env(safe-area-inset-right)' }}
      >
        <div className="pointer-events-auto flex flex-col gap-1">
          <button
            type="button"
            className="viewer-overlay-btn"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-5" />
          </button>
          <button
            type="button"
            className="viewer-overlay-btn"
            title="Scroll to top"
            aria-label="Scroll to top"
            onClick={scrollToTop}
          >
            <ArrowUp className="size-5" />
          </button>
          <button
            type="button"
            className="viewer-overlay-btn"
            title="Reveal in folder"
            aria-label="Reveal in folder"
            onClick={() => void window.frameView.revealInFolder(comic.cover.path)}
          >
            <FolderOpen className="size-5" />
          </button>
        </div>
      </div>

      <div ref={readerRef} className="h-full overflow-auto px-3 pb-6 pt-3">
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
              className="max-h-none w-full max-w-full bg-zinc-900 object-contain"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
