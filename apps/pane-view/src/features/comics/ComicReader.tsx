import type { ComicEntry, MediaItem } from "@latch-works/media-domain";
import { ArrowUp, X } from "lucide-react";
import { type JSX, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { ResolvedMediaImage } from "@/features/gallery/ResolvedMediaImage";
import { useViewerChromeIdle } from "@/hooks/use-viewer-chrome-idle";
import { closeDialog, openDialog } from "@/lib/modal-dialog";

interface ComicReaderProps {
  comic: ComicEntry;
  onClose: () => void;
}

/** Pages start loading this far (in reader heights) before they scroll into view. */
const PAGE_LOAD_MARGIN = "200% 0px";

/** A portrait page's shape, for pages whose size was never recorded. */
const FALLBACK_PAGE_ASPECT_RATIO = "2 / 3";

/** Where `scrollend` is unsupported, a scroll that goes quiet this long has ended. */
const SCROLL_SETTLE_MS = 200;

function pageAspectRatio(page: MediaItem): string {
  return page.width && page.height ? `${page.width} / ${page.height}` : FALLBACK_PAGE_ASPECT_RATIO;
}

export function ComicReader({ comic, onClose }: ComicReaderProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const currentPageIndexRef = useRef(0);
  // The page an arrow key is scrolling to: the smooth scroll passes nearer pages on its way,
  // and neither they nor the next press may start from anywhere else.
  const scrollTargetRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  // What ends a programmatic scroll; the scroll effect swaps in a version that also re-syncs.
  const settleScrollRef = useRef<() => void>(() => undefined);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [nearPageIds, setNearPageIds] = useState<ReadonlySet<string>>(() => new Set());

  const { chromeVisible, revealChrome, chromeVisibilityClass } = useViewerChromeIdle({
    isMobile: false,
  });

  const setCurrentPage = (index: number): void => {
    currentPageIndexRef.current = index;
    setCurrentPageIndex(index);
  };

  const releaseScrollTarget = (): void => {
    scrollTargetRef.current = null;

    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  };

  const armScrollSettle = (): void => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
    }

    settleTimerRef.current = window.setTimeout(() => settleScrollRef.current(), SCROLL_SETTLE_MS);
  };

  // Opened before paint so the gallery never shows through for a frame.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const active = document.activeElement;
    const openedFrom = active instanceof HTMLElement ? active : null;

    if (dialog && !dialog.open) {
      openDialog(dialog);
    }

    // The pages, not a button, take focus: Space and Page Down keep scrolling them.
    readerRef.current?.focus({ preventScroll: true });

    return () => {
      if (dialog) {
        closeDialog(dialog);
      }

      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }

      openedFrom?.focus();
    };
  }, []);

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    revealChrome();

    if (event.key === "Escape") {
      event.preventDefault();
      onClose();

      return;
    }

    const delta =
      event.key === "ArrowRight" || event.key.toLowerCase() === "e"
        ? 1
        : event.key === "ArrowLeft" || event.key.toLowerCase() === "q"
          ? -1
          : 0;

    if (delta === 0) {
      return;
    }

    event.preventDefault();
    const from = scrollTargetRef.current ?? currentPageIndexRef.current;
    const nextIndex = Math.max(0, Math.min(comic.pages.length - 1, from + delta));
    scrollTargetRef.current = nextIndex;
    armScrollSettle();
    setCurrentPage(nextIndex);

    window.requestAnimationFrame(() => {
      pageRefs.current[nextIndex]?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const reader = readerRef.current;

    if (!reader) {
      return undefined;
    }

    let frameId: number | null = null;

    const syncCurrentPage = (): void => {
      frameId = null;

      if (scrollTargetRef.current !== null) {
        return;
      }

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

    // A touch or wheel can cut a smooth scroll short of its target, so count
    // from where it stopped. At the bottom the last pages can't reach the top
    // of the view, and the page asked for stands.
    const settleScroll = (): void => {
      releaseScrollTarget();

      if (reader.scrollTop + reader.clientHeight < reader.scrollHeight - 1) {
        syncCurrentPage();
      }
    };

    settleScrollRef.current = settleScroll;

    const onScroll = (): void => {
      revealChrome();

      if (scrollTargetRef.current !== null) {
        armScrollSettle();

        return;
      }

      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(syncCurrentPage);
    };

    reader.addEventListener("scroll", onScroll, { passive: true });
    reader.addEventListener("scrollend", settleScroll);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      reader.removeEventListener("scroll", onScroll);
      reader.removeEventListener("scrollend", settleScroll);
    };
  }, [revealChrome]);

  // Pages resolve and download only as they come near; once loaded they stay.
  useEffect(() => {
    const reader = readerRef.current;

    if (!reader) {
      return undefined;
    }

    const pageIdByElement = new Map<Element, string>();

    const observer = new IntersectionObserver(
      (entries) => {
        const arrived: string[] = [];

        for (const entry of entries) {
          const pageId = pageIdByElement.get(entry.target);

          if (entry.isIntersecting && pageId) {
            arrived.push(pageId);
            observer.unobserve(entry.target);
          }
        }

        if (arrived.length > 0) {
          setNearPageIds((current) => new Set([...current, ...arrived]));
        }
      },
      { root: reader, rootMargin: PAGE_LOAD_MARGIN },
    );

    comic.pages.forEach((page, index) => {
      const element = pageRefs.current[index];

      if (element) {
        pageIdByElement.set(element, page.id);
        observer.observe(element);
      }
    });

    return () => observer.disconnect();
  }, [comic.pages]);

  const scrollToTop = (): void => {
    readerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Reader for ${comic.name}`}
      className={`fixed inset-0 z-50 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-zinc-950 p-0 text-zinc-100 ${chromeVisible ? "" : "cursor-none"}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseMove={revealChrome}
      onPointerDown={revealChrome}
    >
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/70 via-black/30 to-transparent px-3 pb-8 pt-3 transition-opacity duration-300 ${chromeVisibilityClass}`}
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <div className="pointer-events-auto flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">{comic.name}</p>
            <p className="tabular-nums text-xs text-white/70">
              {currentPageIndex + 1}/{comic.pages.length} pages
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-white/90 transition hover:bg-violet-500/25 hover:text-violet-100"
              title="Scroll to top"
              aria-label="Scroll to top"
              onClick={scrollToTop}
            >
              <ArrowUp className="size-4" />
            </button>
            <button
              type="button"
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-white/90 transition hover:bg-violet-500/25 hover:text-violet-100"
              title="Close"
              aria-label="Close"
              onClick={onClose}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      </div>

      <div
        ref={readerRef}
        className="h-full overflow-auto px-3 pb-6 pt-3 outline-none"
        tabIndex={-1}
      >
        <div className="mx-auto flex w-[min(100%,980px)] flex-col items-center gap-3">
          {comic.pages.map((page, index) => (
            <div
              key={page.id}
              ref={(element) => {
                pageRefs.current[index] = element;
              }}
              className="w-full bg-zinc-900"
              style={{ aspectRatio: pageAspectRatio(page) }}
            >
              {nearPageIds.has(page.id) ? (
                <ResolvedMediaImage
                  alt={page.name}
                  className="h-full w-full object-contain"
                  mediaId={page.id}
                  mediaType={page.mediaType}
                  variant="preview"
                  width={960}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </dialog>
  );
}
