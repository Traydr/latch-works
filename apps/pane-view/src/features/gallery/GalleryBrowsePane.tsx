import type { MediaItem } from "@latch-works/media-domain";
import { type MutableRefObject, memo, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrowserGrid } from "@/features/gallery/BrowserGrid";
import { DetailPanel } from "@/features/gallery/DetailPanel";
import type { GalleryBrowseEntry } from "@/features/gallery/gallery-browse-entry";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

export interface GalleryBrowsePaneProps {
  columnCountRef: MutableRefObject<number>;
  comicMode: boolean;
  /** Why the selected item's last delete failed, if it did. */
  deleteError: string | null;
  deletedEntryIds: ReadonlySet<string>;
  deletingEntryIds: ReadonlySet<string>;
  entries: GalleryBrowseEntry[];
  focusedEntryIndex: number;
  hasMore: boolean;
  isFetching: boolean;
  isMobile: boolean;
  loadingMoreMedia: boolean;
  onActivateEntry: (entry: GalleryBrowseEntry) => void;
  onDelete: () => void;
  onLoadMoreMedia: () => void;
  onNext: () => void;
  onOpenViewer: () => void;
  onPrev: () => void;
  onSelectEntry: (entry: GalleryBrowseEntry) => void;
  /** The comic whose full entry is loading for the reader, if any. */
  openingComicId: string | null;
  scrollRequestKey: number;
  selected: MediaItem | null;
  selectedId: string | null;
  /** Hidden for comic summaries: deleting a comic is folder deletion. */
  showDelete: boolean;
  showDetailPanel: boolean;
  /** Null while a placeholder listing from another browse is on screen. */
  contentKey: string | null;
  paginationResetKey: string;
  thumbnailSize: number;
}

/**
 * Memoised with every callback prop stable, so page state the grid does not
 * show (the search draft, sheets, the hotkey overlay) re-renders none of it.
 */
export const GalleryBrowsePane = memo(function GalleryBrowsePane({
  columnCountRef,
  comicMode,
  deleteError,
  deletedEntryIds,
  deletingEntryIds,
  entries,
  focusedEntryIndex,
  hasMore,
  isFetching,
  isMobile,
  loadingMoreMedia,
  onActivateEntry,
  onDelete,
  onLoadMoreMedia,
  onNext,
  onOpenViewer,
  onPrev,
  onSelectEntry,
  openingComicId,
  scrollRequestKey,
  selected,
  selectedId,
  showDelete,
  showDetailPanel,
  contentKey,
  paginationResetKey,
  thumbnailSize,
}: GalleryBrowsePaneProps) {
  const [loadMoreTrigger, setLoadMoreTrigger] = useState<HTMLDivElement | null>(null);
  const loadMoreTriggerIntersectingRef = useRef(false);
  const loadingMoreMediaRef = useRef(loadingMoreMedia);
  const pathCopy = useCopyToClipboard();

  useEffect(() => {
    loadingMoreMediaRef.current = loadingMoreMedia;
  }, [loadingMoreMedia]);

  useEffect(() => {
    loadMoreTriggerIntersectingRef.current = false;
  }, [paginationResetKey]);

  useEffect(() => {
    if (!hasMore || !loadMoreTrigger) {
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
  }, [hasMore, loadMoreTrigger, onLoadMoreMedia]);

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
            hasMore ? (
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
          isMobile={isMobile}
          onActivateEntry={onActivateEntry}
          onSelectEntry={onSelectEntry}
          openingComicId={openingComicId}
          scrollRequestKey={scrollRequestKey}
          selectedId={selectedId}
          contentKey={contentKey}
        />
      </div>

      {showDetailPanel ? (
        <div className="hidden min-h-0 min-w-0 max-w-[360px] shrink-0 lg:block">
          <DetailPanel
            copyStatus={pathCopy.status}
            deleteError={deleteError}
            isDeleted={selected ? deletedEntryIds.has(selected.id) : false}
            isDeleting={selected ? deletingEntryIds.has(selected.id) : false}
            onCopyPath={() => {
              if (selected) {
                void pathCopy.copy(selected.path);
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
            showDelete={showDelete}
          />
        </div>
      ) : null}
    </div>
  );
});
