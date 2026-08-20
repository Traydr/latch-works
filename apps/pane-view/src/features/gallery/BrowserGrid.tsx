import { Archive } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo } from "react";
import type { GalleryBrowseEntry } from "@/features/gallery/gallery-browse-entry";
import { BrowserEntryCard } from "./BrowserEntryCard";
import { useVirtualGridMetrics } from "./useVirtualGridMetrics";
import { useWindowedThumbnailResolution } from "./useWindowedThumbnailResolution";

interface BrowserGridProps {
  cardWidth: number;
  columnCountRef: RefObject<number>;
  comicMode: boolean;
  deletedEntryIds: ReadonlySet<string>;
  deletingEntryIds: ReadonlySet<string>;
  entries: GalleryBrowseEntry[];
  footer?: ReactNode;
  focusedIndex: number;
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
  const { resolvedThumbnailUrls } = useWindowedThumbnailResolution(contentKey, windowedEntries);

  // Sync column count for keyboard navigation.
  if (columnCountRef.current !== columnCount) {
    columnCountRef.current = columnCount;
  }

  useEffect(() => {
    if (scrollRequestKey === 0 || entries.length === 0) {
      return;
    }

    const element = mainRef.current;
    if (!element) {
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
  }, [cardHeight, columnCount, entries.length, focusedIndex, mainRef, rowStride, scrollRequestKey]);

  return (
    <section
      ref={mainRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto px-5 pb-28 pt-5"
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
                  ? entry.comic.cover.id === selectedId
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
                opening={entry.kind === "comic" && entry.comic.id === openingComicId}
                priority={Math.abs(slot.index - focusedIndex) <= columnCount}
                selected={selected}
                thumbnailUrls={resolvedThumbnailUrls}
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
