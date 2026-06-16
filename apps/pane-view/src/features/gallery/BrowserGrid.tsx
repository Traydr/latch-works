import type { BrowserEntry } from "@latch-works/media-domain";
import { Archive } from "lucide-react";
import { type RefObject, useEffect } from "react";
import { BrowserEntryCard } from "./BrowserEntryCard";
import { useVirtualGridMetrics } from "./useVirtualGridMetrics";

interface BrowserGridProps {
  cardWidth: number;
  columnCountRef: RefObject<number>;
  comicMode: boolean;
  deletedEntryIds: ReadonlySet<string>;
  deletingEntryIds: ReadonlySet<string>;
  entries: BrowserEntry[];
  focusedIndex: number;
  loadMoreSentinelRef?: RefObject<HTMLDivElement | null>;
  onActivateEntry: (entry: BrowserEntry) => void;
  onScrollContainerChange?: (element: HTMLElement | null) => void;
  onSelectEntry: (entry: BrowserEntry) => void;
  scrollFocusedIntoView: boolean;
  onScrolledToFocus: () => void;
  selectedId: string | null;
  thumbnailUrls?: Readonly<Record<string, string>>;
  onWindowedEntriesChange?: (entries: BrowserEntry[]) => void;
}

export function BrowserGrid({
  cardWidth,
  columnCountRef,
  comicMode,
  deletedEntryIds,
  deletingEntryIds,
  entries,
  focusedIndex,
  loadMoreSentinelRef,
  onActivateEntry,
  onScrollContainerChange,
  onSelectEntry,
  scrollFocusedIntoView,
  onScrolledToFocus,
  selectedId,
  thumbnailUrls = {},
  onWindowedEntriesChange,
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

  // Sync column count for keyboard navigation.
  if (columnCountRef.current !== columnCount) {
    columnCountRef.current = columnCount;
  }

  useEffect(() => {
    onScrollContainerChange?.(mainRef.current);
    return () => onScrollContainerChange?.(null);
  }, [mainRef, onScrollContainerChange]);

  useEffect(() => {
    if (!onWindowedEntriesChange) {
      return;
    }

    const visibleEntries = windowedItems
      .map((slot) => entries[slot.index])
      .filter((entry): entry is BrowserEntry => Boolean(entry));
    onWindowedEntriesChange(visibleEntries);
  }, [entries, onWindowedEntriesChange, windowedItems]);

  useEffect(() => {
    if (!scrollFocusedIntoView || entries.length === 0) {
      return;
    }

    const element = mainRef.current;
    if (!element) {
      onScrolledToFocus();
      return;
    }

    const row = Math.floor(focusedIndex / columnCount);
    const itemTop = row * rowStride;
    const itemBottom = itemTop + cardHeight;
    const padding = 24;
    const viewTop = element.scrollTop;
    const viewBottom = viewTop + element.clientHeight;

    if (itemTop < viewTop + padding) {
      element.scrollTop = Math.max(0, itemTop - padding);
    } else if (itemBottom > viewBottom - padding) {
      element.scrollTop = itemBottom - element.clientHeight + padding;
    }

    onScrolledToFocus();
  }, [
    cardHeight,
    columnCount,
    entries.length,
    focusedIndex,
    mainRef,
    onScrolledToFocus,
    rowStride,
    scrollFocusedIntoView,
  ]);

  return (
    <section
      ref={mainRef}
      className="min-w-0 flex-1 overflow-auto px-5 pb-28 pt-5"
      aria-label="Archive browser"
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

            const selected =
              entry.kind === "folder"
                ? false
                : entry.kind === "comic"
                  ? entry.comic.pages.some((page) => page.id === selectedId)
                  : entry.media.id === selectedId;
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
                left={slot.left}
                onActivate={onActivateEntry}
                onSelect={onSelectEntry}
                priority={Math.abs(slot.index - focusedIndex) <= columnCount}
                selected={selected}
                thumbnailUrls={thumbnailUrls}
                top={slot.top}
              />
            );
          })}
        </div>
      )}
      <div ref={loadMoreSentinelRef} aria-hidden className="h-px w-px" />
    </section>
  );
}
