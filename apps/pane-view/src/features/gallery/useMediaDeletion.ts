import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { GalleryBrowseSession } from "@/features/gallery/useGalleryBrowse";
import { useDeleteLibraryEntryMutation } from "@/features/library/library-queries";
import type { LibraryMediaItem } from "@/features/library/types";

export interface DeletedMediaIds {
  ids: ReadonlySet<string>;
  setIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
}

/**
 * Media deleted here, hidden until the refetch drops it. The browse session
 * skips these ids while stepping, so the page creates them before the
 * session; `useMediaDeletion` does every write.
 */
export function useDeletedMediaIds(): DeletedMediaIds {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  return { ids, setIds };
}

/** `ids` without the ones no longer live; `ids` itself when none dropped out. */
function retainLiveIds(
  ids: ReadonlySet<string>,
  liveIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const next = new Set([...ids].filter((id) => liveIds.has(id)));

  return next.size === ids.size ? ids : next;
}

export interface UseMediaDeletionOptions {
  /** Every media item on screen; ids that leave it are forgotten once the library has loaded. */
  allMedia: readonly LibraryMediaItem[];
  browseKey: string;
  deletedMedia: DeletedMediaIds;
  library: GalleryBrowseSession["library"];
  navigableMedia: readonly LibraryMediaItem[];
  /** Moves the selection to the neighbour of an item deleted while selected. */
  onSelectNeighbour: (mediaId: string) => void;
  selected: LibraryMediaItem | null;
}

export interface MediaDeletion {
  deleteSelectedMedia: () => void;
  deletingEntryIds: ReadonlySet<string>;
  /** Why the selected item's last delete failed, if it did. */
  selectedDeleteError: string | null;
}

export function useMediaDeletion({
  allMedia,
  browseKey,
  deletedMedia,
  library,
  navigableMedia,
  onSelectNeighbour,
  selected,
}: UseMediaDeletionOptions): MediaDeletion {
  const { ids: deletedEntryIds, setIds: setDeletedEntryIds } = deletedMedia;
  const [deletingEntryIds, setDeletingEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deleteError, setDeleteError] = useState<{ entryId: string; message: string } | null>(null);
  const { mutateAsync: deleteEntry } = useDeleteLibraryEntryMutation();

  useEffect(() => {
    if (!library) {
      return;
    }

    const liveIds = new Set(allMedia.map((item) => item.id));
    setDeletedEntryIds((current) => retainLiveIds(current, liveIds));
    setDeletingEntryIds((current) => retainLiveIds(current, liveIds));
  }, [allMedia, library, setDeletedEntryIds]);

  // A delete settles after the render it started in: it reads the live
  // browse, sequence, and selection from here.
  const liveDeleteRef = useRef({ browseKey, navigableMedia, selectedId: selected?.id ?? null });
  liveDeleteRef.current = { browseKey, navigableMedia, selectedId: selected?.id ?? null };

  const deleteSelectedMedia = useCallback(() => {
    if (!selected || deletedEntryIds.has(selected.id) || deletingEntryIds.has(selected.id)) {
      return;
    }

    const confirmed = window.confirm(
      `Delete "${selected.name}" from the archive? This cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    const entryId = selected.id;
    const startBrowseKey = browseKey;

    setDeleteError(null);
    setDeletingEntryIds((current) => new Set([...current, entryId]));

    void (async () => {
      try {
        // `deleted: false` means no live row matched: the item is already
        // gone, so hide it like a delete that just landed.
        await deleteEntry(entryId);

        setDeletedEntryIds((current) => new Set([...current, entryId]));

        // Move to the neighbour only if the user has not moved on meanwhile.
        const live = liveDeleteRef.current;

        if (live.browseKey !== startBrowseKey || live.selectedId !== entryId) {
          return;
        }

        const liveIndex = live.navigableMedia.findIndex((item) => item.id === entryId);
        const remaining = live.navigableMedia.filter((item) => item.id !== entryId);
        const next = remaining[liveIndex >= 0 ? Math.min(liveIndex, remaining.length - 1) : 0];

        if (next) {
          onSelectNeighbour(next.id);
        }
      } catch (error) {
        setDeleteError({
          entryId,
          message: error instanceof Error ? error.message : "Delete failed.",
        });
      } finally {
        setDeletingEntryIds((current) => {
          const next = new Set(current);
          next.delete(entryId);

          return next;
        });
      }
    })();
  }, [
    browseKey,
    deleteEntry,
    deletedEntryIds,
    deletingEntryIds,
    onSelectNeighbour,
    selected,
    setDeletedEntryIds,
  ]);

  return {
    deleteSelectedMedia,
    deletingEntryIds,
    selectedDeleteError:
      deleteError && deleteError.entryId === selected?.id ? deleteError.message : null,
  };
}
