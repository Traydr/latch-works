import { Archive } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from "react";
import { entryMedia, type GalleryBrowseEntry } from "@/features/gallery/gallery-browse-entry";
import { BrowserEntryCard } from "./BrowserEntryCard";
import { FLOATING_TOOLBAR_SELECTOR, GALLERY_GRID_SCROLL_ID } from "./gallery-grid-scroll";
import { useVirtualGridMetrics } from "./useVirtualGridMetrics";
import { useWindowedThumbnailResolution } from "./useWindowedThumbnailResolution";

/** How much of the grid's bottom edge the fixed FloatingToolbar covers, measured from the DOM. */
function floatingToolbarInset(grid: HTMLElement): number {
  const toolbar = document.querySelector(FLOATING_TOOLBAR_SELECTOR);

  if (!toolbar) {
    return 0;
  }

  return Math.max(0, grid.getBoundingClientRect().bottom - toolbar.getBoundingClientRect().top);
}

interface BrowserGridProps {
  cardWidth: number;
  columnCountRef: RefObject<number>;
  comicMode: boolean;
  deletedEntryIds: ReadonlySet<string>;
  deletingEntryIds: ReadonlySet<string>;
  entries: GalleryBrowseEntry[];
  footer?: ReactNode;
  focusedIndex: number;
  isMobile: boolean;
  onActivateEntry: (entry: GalleryBrowseEntry) => void;
  onSelectEntry: (entry: GalleryBrowseEntry) => void;
  openingComicId: string | null;
  scrollRequestKey: number;
  selectedId: string | null;
  contentKey: string | null;
}

export function BrowserGrid({
  cardWidth,
  columnCountRef,
  comicMode,
  deletedEntryIds,
  deletingEntryIds,
  entries,
  footer,
  focusedIndex,
  isMobile,
  onActivateEntry,
  onSelectEntry,
  openingComicId,
  scrollRequestKey,
  selectedId,
  contentKey,
}: BrowserGridProps) {
  const {
    cardHeight,
    cardWidth: measuredCardWidth,
    columnCount,
    gridWidth,
    mainRef,
    rowStride,
    totalGridHeight,
    windowedItems,
  } = useVirtualGridMetrics(entries.length, cardWidth, comicMode ? "tall" : "wide");

  const resolvedCardWidth = measuredCardWidth || cardWidth;

  const windowedEntries = useMemo(
    () =>
      windowedItems
        .map((slot) => entries[slot.index])
        .filter((entry): entry is GalleryBrowseEntry => Boolean(entry)),
    [entries, windowedItems],
  );

  const { resolvedThumbnailUrls } = useWindowedThumbnailResolution({
    entries: windowedEntries,
    key: contentKey,
  });

  // Sync column count for keyboard navigation.
  if (columnCountRef.current !== columnCount) {
    columnCountRef.current = columnCount;
  }

  // Scroll only for a new request: the effect also re-runs when a page loads
  // or the grid resizes, and snapping back to the focused card then would
  // fight the user's own scrolling. Mounting is not a request either.
  const handledScrollRequestKeyRef = useRef(scrollRequestKey);

  useEffect(() => {
    if (scrollRequestKey === handledScrollRequestKeyRef.current || entries.length === 0) {
      return;
    }

    const element = mainRef.current;

    if (!element) {
      return;
    }

    handledScrollRequestKeyRef.current = scrollRequestKey;

    // The grid starts below the section's top padding.
    const gridTop = Number.parseFloat(getComputedStyle(element).paddingTop) || 0;
    const bottomInset = floatingToolbarInset(element);
    const row = Math.floor(focusedIndex / columnCount);
    const itemTop = gridTop + row * rowStride;
    const itemBottom = itemTop + cardHeight;
    const padding = 24;
    const viewTop = element.scrollTop;
    const viewBottom = viewTop + element.clientHeight - bottomInset;

    if (itemTop < viewTop + padding) {
      element.scrollTop = Math.max(0, itemTop - padding);
    } else if (itemBottom > viewBottom - padding) {
      element.scrollTop = itemBottom - element.clientHeight + bottomInset + padding;
    }
  }, [cardHeight, columnCount, entries.length, focusedIndex, mainRef, rowStride, scrollRequestKey]);

  return (
    <section
      ref={mainRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto px-5 pb-28 pt-5"
      aria-label="Archive browser"
      data-scroll-restoration-id={GALLERY_GRID_SCROLL_ID}
    >
      {entries.length === 0 ? (
        <div className="grid min-h-60 place-items-center rounded-lg border border-dashed border-zinc-800 text-center">
          <div className="grid max-w-xs justify-items-center gap-2 text-sm text-zinc-400">
            <Archive className="size-6" />
            <strong className="text-zinc-100">No archive entries</strong>
            <span>Sync media or choose another archive path.</span>
          </div>
        </div>
      ) : (
        <div
          className="relative mx-auto"
          style={{
            width: `${gridWidth}px`,
            height: `${totalGridHeight}px`,
          }}
        >
          {windowedItems.map((slot) => {
            const entry = entries[slot.index];

            if (!entry) {
              return null;
            }

            const mediaId = entryMedia(entry)?.id;
            const selected = mediaId !== undefined && mediaId === selectedId;

            const focused = slot.index === focusedIndex;

            return (
              <BrowserEntryCard
                key={entry.key}
                cardHeight={cardHeight}
                cardWidth={resolvedCardWidth}
                deletedEntryIds={deletedEntryIds}
                deletingEntryIds={deletingEntryIds}
                entry={entry}
                focused={focused}
                isMobile={isMobile}
                left={slot.left}
                onActivate={onActivateEntry}
                onSelect={onSelectEntry}
                opening={entry.kind === "comic" && entry.comic.id === openingComicId}
                priority={Math.abs(slot.index - focusedIndex) <= columnCount}
                selected={selected}
                thumbnailUrl={mediaId === undefined ? undefined : resolvedThumbnailUrls[mediaId]}
                top={slot.top}
              />
            );
          })}
        </div>
      )}
      {footer}
    </section>
  );
}
