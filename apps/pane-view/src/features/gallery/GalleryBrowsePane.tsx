import type { BrowserEntry, MediaItem } from "@latch-works/media-domain";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrowserGrid } from "@/features/gallery/BrowserGrid";
import { DetailPanel } from "@/features/gallery/DetailPanel";
import { cn } from "@/lib/utils";
import type { MediaPage } from "@/server/library/types";

export interface GalleryBrowsePaneProps {
  columnCountRef: MutableRefObject<number>;
  comicMode: boolean;
  deletedEntryIds: ReadonlySet<string>;
  deletingEntryIds: ReadonlySet<string>;
  entries: BrowserEntry[];
  focusedEntryIndex: number;
  isFetching: boolean;
  loadingMoreMedia: boolean;
  mediaPage: MediaPage | null;
  onActivateEntry: (entry: BrowserEntry) => void;
  onDelete: () => void;
  onLoadMoreMedia: () => void;
  onNext: () => void;
  onOpenViewer: () => void;
  onPrev: () => void;
  onScrolledToFocus: () => void;
  onSelectEntry: (entry: BrowserEntry) => void;
  onWindowedEntriesChange: (entries: BrowserEntry[]) => void;
  resolvedThumbnailUrls: Readonly<Record<string, string>>;
  scrollFocusedIntoView: boolean;
  selected: MediaItem | null;
  selectedId: string | null;
  showDetailPanel: boolean;
  paginationResetKey: string;
  thumbnailSize: number;
}

export function GalleryBrowsePane({
  columnCountRef,
  comicMode,
  deletedEntryIds,
  deletingEntryIds,
  entries,
  focusedEntryIndex,
  isFetching,
  loadingMoreMedia,
  mediaPage,
  onActivateEntry,
  onDelete,
  onLoadMoreMedia,
  onNext,
  onOpenViewer,
  onPrev,
  onScrolledToFocus,
  onSelectEntry,
  onWindowedEntriesChange,
  resolvedThumbnailUrls,
  scrollFocusedIntoView,
  selected,
  selectedId,
  showDetailPanel,
  paginationResetKey,
  thumbnailSize,
}: GalleryBrowsePaneProps) {
  const [loadMoreTrigger, setLoadMoreTrigger] = useState<HTMLDivElement | null>(null);
  const loadMoreTriggerIntersectingRef = useRef(false);
  const loadingMoreMediaRef = useRef(loadingMoreMedia);
  loadingMoreMediaRef.current = loadingMoreMedia;

  useEffect(() => {
    loadMoreTriggerIntersectingRef.current = false;
  }, [paginationResetKey]);

  useEffect(() => {
    if (!mediaPage?.hasMore || !loadMoreTrigger) {
      return;
    }

    const observer = new IntersectionObserver(
      (observerEntries) => {
        const isIntersecting = observerEntries.some((entry) => entry.isIntersecting);
        const wasIntersecting = loadMoreTriggerIntersectingRef.current;
        loadMoreTriggerIntersectingRef.current = isIntersecting;

        if (isIntersecting && !wasIntersecting && !loadingMoreMediaRef.current) {
          onLoadMoreMedia();
        }
      },
      { root: null, rootMargin: "0px", threshold: 0 },
    );

    observer.observe(loadMoreTrigger);
    return () => observer.disconnect();
  }, [loadMoreTrigger, mediaPage?.hasMore, onLoadMoreMedia]);

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 overflow-hidden",
        isFetching && "opacity-80 transition-opacity",
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <BrowserGrid
          cardWidth={thumbnailSize}
          comicMode={comicMode}
          columnCountRef={columnCountRef}
          deletedEntryIds={deletedEntryIds}
          deletingEntryIds={deletingEntryIds}
          entries={entries}
          footer={
            mediaPage?.hasMore ? (
              <div className="mt-4 flex justify-center border-t border-border pt-3">
                <div ref={setLoadMoreTrigger} className="inline-flex">
                  <Button
                    disabled={loadingMoreMedia}
                    onClick={onLoadMoreMedia}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {loadingMoreMedia ? "Loading more…" : "Load more"}
                  </Button>
                </div>
              </div>
            ) : null
          }
          focusedIndex={focusedEntryIndex}
          onActivateEntry={onActivateEntry}
          onScrolledToFocus={onScrolledToFocus}
          onSelectEntry={onSelectEntry}
          onWindowedEntriesChange={onWindowedEntriesChange}
          scrollFocusedIntoView={scrollFocusedIntoView}
          selectedId={selectedId}
          thumbnailUrls={resolvedThumbnailUrls}
        />
      </div>

      {showDetailPanel ? (
        <div className="hidden min-h-0 min-w-0 max-w-[360px] shrink-0 lg:block">
          <DetailPanel
            isDeleted={selected ? deletedEntryIds.has(selected.id) : false}
            isDeleting={selected ? deletingEntryIds.has(selected.id) : false}
            onCopyPath={() => {
              if (selected) {
                void navigator.clipboard.writeText(selected.path);
              }
            }}
            onDelete={onDelete}
            onDownload={() => {
              if (selected) {
                window.open(`/api/media/${selected.id}/original`, "_blank", "noopener,noreferrer");
              }
            }}
            onNext={onNext}
            onOpenViewer={onOpenViewer}
            onPrev={onPrev}
            selected={selected}
            showDelete
          />
        </div>
      ) : null}
    </div>
  );
}
