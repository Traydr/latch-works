import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import { getParentPath, isTextInputTarget } from "@/features/gallery/browse-search";
import type { GalleryBrowseEntry } from "@/features/gallery/gallery-browse-entry";

export interface UseGalleryKeyboardOptions {
  columnCountRef: MutableRefObject<number>;
  displayPath: string;
  entries: GalleryBrowseEntry[];
  focusedEntryIndex: number;
  hotkeysOpen: boolean;
  mobileSearchOpen: boolean;
  onActivateEntry: (entry: GalleryBrowseEntry) => void;
  onCloseOverlays: () => void;
  onNavigateSiblingFolder: (offset: -1 | 1) => void;
  onNavigateToPath: (path: string) => void;
  onOpenHotkeys: () => void;
  onSelectMedia: (mediaId: string) => void;
  /**
   * Called when a move leaves the loaded grid: forward past the last entry or
   * backward before the first. Resolves to the entry key to focus, or null to
   * stay put. The session decides whether that loads a page or wraps.
   */
  onStepBeyondGrid: (currentKey: string | null, direction: -1 | 1) => Promise<string | null>;
  pathSheetOpen: boolean;
  setFocusedEntryIndex: (index: number | ((current: number) => number)) => void;
  requestScrollFocusedIntoView: () => void;
  settingsOpen: boolean;
  viewerOpen: boolean;
}

/**
 * Browse-only keyboard shortcuts. Viewer keys stay in MediaViewerModal.
 */
export function useGalleryKeyboard({
  columnCountRef,
  displayPath,
  entries,
  focusedEntryIndex,
  hotkeysOpen,
  mobileSearchOpen,
  onActivateEntry,
  onCloseOverlays,
  onNavigateSiblingFolder,
  onNavigateToPath,
  onOpenHotkeys,
  onSelectMedia,
  onStepBeyondGrid,
  pathSheetOpen,
  setFocusedEntryIndex,
  requestScrollFocusedIntoView,
  settingsOpen,
  viewerOpen,
}: UseGalleryKeyboardOptions): void {
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const pendingFocusKeyRef = useRef<string | null>(null);

  const focusEntryByKey = useCallback(
    (key: string): boolean => {
      const index = entriesRef.current.findIndex((entry) => entry.key === key);
      if (index < 0) {
        return false;
      }
      setFocusedEntryIndex(index);
      requestScrollFocusedIntoView();
      const entry = entriesRef.current[index];
      if (entry?.kind === "media") {
        onSelectMedia(entry.media.id);
      } else if (entry?.kind === "comic") {
        onSelectMedia(entry.comic.cover.id);
      }
      return true;
    },
    [onSelectMedia, requestScrollFocusedIntoView, setFocusedEntryIndex],
  );

  // A key resolved by the session before its page rendered: focus it once the
  // entries include it. Depends on `entries` because that is the signal that
  // the appended page has committed.
  useEffect(() => {
    if (pendingFocusKeyRef.current && focusEntryByKey(pendingFocusKeyRef.current)) {
      pendingFocusKeyRef.current = null;
    }
  }, [entries, focusEntryByKey]);

  useEffect(() => {
    const moveGridFocus = (dx: number, dy: number) => {
      if (!entries.length) {
        return;
      }

      const columnCount = columnCountRef.current;
      const currentRow = Math.floor(focusedEntryIndex / columnCount);
      const currentCol = focusedEntryIndex % columnCount;

      const nextRow = currentRow + dy;
      const nextCol = currentCol + dx;
      const nextIndex = nextRow * columnCount + nextCol;

      const applyFocus = (index: number) => {
        setFocusedEntryIndex(index);
        requestScrollFocusedIntoView();
        const entry = entries[index];
        if (entry?.kind === "media") {
          onSelectMedia(entry.media.id);
        } else if (entry?.kind === "comic") {
          onSelectMedia(entry.comic.cover.id);
        }
      };

      if (nextIndex >= 0 && nextIndex < entries.length) {
        applyFocus(nextIndex);
        return;
      }

      // Off the loaded grid. Geometry stays here: only a move past the true
      // sequence boundary (Left/Up from the first entry, Right/Down from the
      // last row) is delegated to the session, which loads the next page,
      // wraps, or stays put. Focus lands by key so an appended page cannot
      // shift it. Any other overflow (Up from the top row, Down from the
      // second-to-last row into a shorter last row) clamps.
      const lastIndex = entries.length - 1;
      const lastRow = Math.floor(lastIndex / columnCount);
      const stepBeyond = (direction: -1 | 1) => {
        const currentKey = entries[focusedEntryIndex]?.key ?? null;
        void onStepBeyondGrid(currentKey, direction).then((key) => {
          if (key && !focusEntryByKey(key)) {
            pendingFocusKeyRef.current = key;
          }
        });
      };
      if (nextIndex < 0) {
        if (focusedEntryIndex === 0) {
          stepBeyond(-1);
        }
        return;
      }
      if (dy > 0 && currentRow < lastRow) {
        applyFocus(lastIndex);
        return;
      }
      stepBeyond(1);
    };

    const handleGalleryKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      if (event.shiftKey) {
        if (key === "w") {
          event.preventDefault();
          const parent = getParentPath(displayPath);
          onNavigateToPath(parent ?? "");
          return;
        }
        if (key === "s") {
          event.preventDefault();
          const entry = entries[focusedEntryIndex];
          if (entry?.kind === "folder") {
            onNavigateToPath(entry.path);
          }
          return;
        }
        if (key === "a") {
          event.preventDefault();
          onNavigateSiblingFolder(-1);
          return;
        }
        if (key === "d") {
          event.preventDefault();
          onNavigateSiblingFolder(1);
          return;
        }
      }

      if (key === "ArrowRight" || key === "d") {
        event.preventDefault();
        moveGridFocus(1, 0);
        return;
      }
      if (key === "ArrowLeft" || key === "a") {
        event.preventDefault();
        moveGridFocus(-1, 0);
        return;
      }
      if (key === "ArrowDown" || key === "s") {
        event.preventDefault();
        moveGridFocus(0, 1);
        return;
      }
      if (key === "ArrowUp" || key === "w") {
        event.preventDefault();
        moveGridFocus(0, -1);
        return;
      }

      if (key === "Enter" || key === "f") {
        event.preventDefault();
        const entry = entries[focusedEntryIndex];
        if (entry) {
          onActivateEntry(entry);
        }
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen || hotkeysOpen || mobileSearchOpen || pathSheetOpen) {
        if (event.key === "Escape") {
          onCloseOverlays();
        }
        return;
      }

      if (isTextInputTarget(event.target)) {
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        onOpenHotkeys();
        return;
      }

      if (viewerOpen) {
        return;
      }

      handleGalleryKeyDown(event);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    columnCountRef,
    displayPath,
    entries,
    focusEntryByKey,
    focusedEntryIndex,
    hotkeysOpen,
    mobileSearchOpen,
    onActivateEntry,
    onCloseOverlays,
    onNavigateSiblingFolder,
    onNavigateToPath,
    onOpenHotkeys,
    onSelectMedia,
    onStepBeyondGrid,
    pathSheetOpen,
    setFocusedEntryIndex,
    requestScrollFocusedIntoView,
    settingsOpen,
    viewerOpen,
  ]);
}
