import { useEffect } from 'react';

import type { BrowserEntry, BrowserEntryCollection } from '../utils/browserEntries';
import {
  eventKey,
  HOTKEYS,
  isPlainHotkeyEvent,
  isTextInputTarget,
  matchesAnyKey,
} from '../utils/hotkeys';

interface UseGalleryKeyboardNavigationOptions {
  viewerIndex: number | null;
  settingsOpen: boolean;
  browserEntries: BrowserEntryCollection;
  selectedBrowserEntry: BrowserEntry | null;
  selectedBrowserEntryIndex: number;
  selectBrowserEntryAction: (entry: BrowserEntry) => void;
  activateBrowserEntryAction: (entry: BrowserEntry) => void;
  openParentFolderAction: () => void;
  openSiblingFolderAction: (direction: -1 | 1) => void;
  navigateToFolderAction: (folderPath: string) => void;
}

export function useGalleryKeyboardNavigation({
  viewerIndex,
  settingsOpen,
  browserEntries,
  selectedBrowserEntry,
  selectedBrowserEntryIndex,
  selectBrowserEntryAction,
  activateBrowserEntryAction,
  openParentFolderAction,
  openSiblingFolderAction,
  navigateToFolderAction,
}: UseGalleryKeyboardNavigationOptions): void {
  useEffect(() => {
    if (viewerIndex !== null || settingsOpen) {
      return;
    }

    const getGridColumnCount = (): number => {
      const grid = document.querySelector<HTMLElement>('[data-gallery-grid="true"]');
      if (!grid) {
        return 1;
      }

      const configuredColumns = Number(grid.dataset.galleryColumns ?? Number.NaN);
      if (Number.isFinite(configuredColumns) && configuredColumns > 0) {
        return Math.max(1, Math.floor(configuredColumns));
      }

      const cells = Array.from(grid.querySelectorAll<HTMLElement>('[data-gallery-item="true"]'));
      if (cells.length === 0) {
        return 1;
      }

      const firstRowTop = cells[0]?.offsetTop ?? 0;
      let columns = 0;
      for (const cell of cells) {
        if (cell.offsetTop !== firstRowTop) {
          break;
        }
        columns += 1;
      }

      return Math.max(1, columns);
    };

    const wrapIndex = (value: number): number => {
      return ((value % browserEntries.length) + browserEntries.length) % browserEntries.length;
    };

    const selectIndex = (nextIndex: number): void => {
      const nextEntry = browserEntries.at(nextIndex);
      if (!nextEntry) {
        return;
      }

      selectBrowserEntryAction(nextEntry);

      window.requestAnimationFrame(() => {
        const safeItemId =
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(nextEntry.key)
            : nextEntry.key.replace(/"/g, '\\"');
        const nextCell = document.querySelector<HTMLElement>(
          `[data-gallery-item-id="${safeItemId}"]`,
        );

        if (nextCell) {
          nextCell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          return;
        }

        const grid = document.querySelector<HTMLElement>('[data-gallery-grid="true"]');
        const scrollContainer = document.querySelector<HTMLElement>(
          '[data-gallery-scroll-container="true"]',
        );
        if (!grid || !scrollContainer) {
          return;
        }

        const columns = Number(grid.dataset.galleryColumns ?? Number.NaN);
        const rowHeight = Number(grid.dataset.galleryRowHeight ?? Number.NaN);

        if (
          !Number.isFinite(columns) ||
          columns <= 0 ||
          !Number.isFinite(rowHeight) ||
          rowHeight <= 0
        ) {
          return;
        }

        const targetRow = Math.floor(nextIndex / columns);
        const targetTop = Math.max(0, targetRow * rowHeight - scrollContainer.clientHeight * 0.35);
        scrollContainer.scrollTo({ top: targetTop, behavior: 'smooth' });
      });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (document.body.dataset.frameViewFolderOverlay === 'open') {
        return;
      }

      if (isTextInputTarget(event.target)) {
        return;
      }

      if (!isPlainHotkeyEvent(event)) {
        return;
      }

      if (
        matchesAnyKey(event, ['ArrowRight', 'ArrowLeft']) ||
        (!event.shiftKey && matchesAnyKey(event, ['a', 'd']))
      ) {
        if (browserEntries.length === 0) {
          return;
        }

        event.preventDefault();
        const direction = matchesAnyKey(event, HOTKEYS.galleryMoveRight) ? 1 : -1;
        const startIndex = selectedBrowserEntryIndex >= 0 ? selectedBrowserEntryIndex : 0;
        const nextIndex = wrapIndex(startIndex + direction);
        selectIndex(nextIndex);
        return;
      }

      if (
        matchesAnyKey(event, ['ArrowUp', 'ArrowDown']) ||
        (!event.shiftKey && matchesAnyKey(event, ['w', 's']))
      ) {
        if (browserEntries.length === 0) {
          return;
        }

        event.preventDefault();
        const rowSize = getGridColumnCount();
        const direction = matchesAnyKey(event, HOTKEYS.galleryMoveDown) ? 1 : -1;
        const startIndex = selectedBrowserEntryIndex >= 0 ? selectedBrowserEntryIndex : 0;
        const nextIndex = wrapIndex(startIndex + direction * rowSize);
        selectIndex(nextIndex);
        return;
      }

      const key = eventKey(event);

      if (event.shiftKey && key === 'w') {
        event.preventDefault();
        openParentFolderAction();
        return;
      }

      if (event.shiftKey && key === 'a') {
        event.preventDefault();
        openSiblingFolderAction(-1);
        return;
      }

      if (event.shiftKey && key === 'd') {
        event.preventDefault();
        openSiblingFolderAction(1);
        return;
      }

      if (event.shiftKey && key === 's') {
        const selectedFolderEntry =
          selectedBrowserEntry?.kind === 'folder' ? selectedBrowserEntry : null;
        let firstFolderEntry: BrowserEntry | null = null;
        for (let index = 0; index < browserEntries.length; index += 1) {
          const entry = browserEntries.at(index);
          if (entry?.kind === 'folder') {
            firstFolderEntry = entry;
            break;
          }
        }

        const folderToOpen = selectedFolderEntry ?? firstFolderEntry;
        if (folderToOpen?.kind !== 'folder') {
          return;
        }

        event.preventDefault();
        navigateToFolderAction(folderToOpen.path);
        return;
      }

      if (matchesAnyKey(event, HOTKEYS.galleryActivate) && selectedBrowserEntry) {
        event.preventDefault();
        activateBrowserEntryAction(selectedBrowserEntry);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activateBrowserEntryAction,
    browserEntries,
    navigateToFolderAction,
    openParentFolderAction,
    openSiblingFolderAction,
    selectBrowserEntryAction,
    selectedBrowserEntry,
    selectedBrowserEntryIndex,
    settingsOpen,
    viewerIndex,
  ]);
}
