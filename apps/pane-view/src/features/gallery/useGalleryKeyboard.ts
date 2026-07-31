import type { BrowserEntry } from "@latch-works/media-domain";
import { type MutableRefObject, useEffect } from "react";
import { getParentPath, isTextInputTarget } from "@/features/gallery/browse-search";

export interface UseGalleryKeyboardOptions {
  columnCountRef: MutableRefObject<number>;
  displayPath: string;
  entries: BrowserEntry[];
  focusedEntryIndex: number;
  hotkeysOpen: boolean;
  mobileSearchOpen: boolean;
  onActivateEntry: (entry: BrowserEntry) => void;
  onCloseOverlays: () => void;
  onNavigateSiblingFolder: (offset: -1 | 1) => void;
  onNavigateToPath: (path: string) => void;
  onOpenHotkeys: () => void;
  onSelectMedia: (mediaId: string) => void;
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
  pathSheetOpen,
  setFocusedEntryIndex,
  requestScrollFocusedIntoView,
  settingsOpen,
  viewerOpen,
}: UseGalleryKeyboardOptions): void {
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

      if (nextIndex < 0 || nextIndex >= entries.length) {
        if (entries.length === 0) {
          return;
        }

        const wrappedIndex =
          nextIndex < 0 ? entries.length - 1 : nextIndex >= entries.length ? 0 : nextIndex;
        applyFocus(wrappedIndex);
        return;
      }

      if (nextIndex >= 0 && nextIndex < entries.length) {
        applyFocus(nextIndex);
      }
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
    focusedEntryIndex,
    hotkeysOpen,
    mobileSearchOpen,
    onActivateEntry,
    onCloseOverlays,
    onNavigateSiblingFolder,
    onNavigateToPath,
    onOpenHotkeys,
    onSelectMedia,
    pathSheetOpen,
    setFocusedEntryIndex,
    requestScrollFocusedIntoView,
    settingsOpen,
    viewerOpen,
  ]);
}
