import type { BrowserEntry } from "@latch-works/media-domain";
import { Archive } from "lucide-react";
import { BrowserEntryCard } from "./BrowserEntryCard";
import { useVirtualGridMetrics } from "./useVirtualGridMetrics";

interface BrowserGridProps {
  comicMode: boolean;
  entries: BrowserEntry[];
  onActivateEntry: (entry: BrowserEntry) => void;
  onSelectEntry: (entry: BrowserEntry) => void;
  selectedId: string | null;
}

export function BrowserGrid({
  comicMode,
  entries,
  onActivateEntry,
  onSelectEntry,
  selectedId,
}: BrowserGridProps) {
  const { cardHeight, cardWidth, gridWidth, mainRef, totalGridHeight, windowedItems } =
    useVirtualGridMetrics(entries.length, 220, comicMode ? "tall" : "wide");

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

            return (
              <BrowserEntryCard
                key={entry.key}
                cardHeight={cardHeight}
                cardWidth={cardWidth}
                entry={entry}
                left={slot.left}
                onActivate={onActivateEntry}
                onSelect={onSelectEntry}
                selected={selected}
                top={slot.top}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
