import { useCallback, useEffect, useMemo, useState } from 'react';

import type { BrowserEntry, BrowserEntryCollection } from '../utils/browserEntries';
import { getMediaEntryKey } from '../utils/browserEntries';

interface UseBrowserSelectionResult {
  activateBrowserEntryAction: (entry: BrowserEntry) => void;
  selectBrowserEntryAction: (entry: BrowserEntry) => void;
  selectedBrowserEntry: BrowserEntry | null;
  selectedBrowserEntryIndex: number;
  selectedBrowserEntryKey: string | null;
}

export function useBrowserSelection({
  browserEntries,
  navigateToFolderAction,
  openComicReader,
  openViewerAt,
  pendingFolderSelectionPath,
  selectedId,
  setPendingFolderSelectionPath,
  setSelectedId,
}: {
  browserEntries: BrowserEntryCollection;
  navigateToFolderAction: (folderPath: string) => void;
  openComicReader: (comic: Extract<BrowserEntry, { kind: 'comic' }>['comic']) => void;
  openViewerAt: (index: number) => void;
  pendingFolderSelectionPath: string | null;
  selectedId: string | null;
  setPendingFolderSelectionPath: (path: string | null) => void;
  setSelectedId: (id: string | null) => void;
}): UseBrowserSelectionResult {
  const [selectedBrowserEntryKey, setSelectedBrowserEntryKey] = useState<string | null>(null);

  useEffect(() => {
    setSelectedBrowserEntryKey((current) => {
      if (pendingFolderSelectionPath) {
        const pendingFolderKey = `folder:${pendingFolderSelectionPath}`;
        if (browserEntries.findIndexByKey(pendingFolderKey) >= 0) {
          return pendingFolderKey;
        }
      }

      if (selectedId) {
        const selectedMediaKey = getMediaEntryKey(selectedId);
        if (browserEntries.findIndexByKey(selectedMediaKey) >= 0) {
          return selectedMediaKey;
        }
      }

      if (current && browserEntries.findIndexByKey(current) >= 0) {
        return current;
      }

      return browserEntries.firstKey();
    });
  }, [browserEntries, pendingFolderSelectionPath, selectedId]);

  useEffect(() => {
    if (!pendingFolderSelectionPath) {
      return;
    }

    const pendingFolderKey = `folder:${pendingFolderSelectionPath}`;
    if (selectedBrowserEntryKey === pendingFolderKey) {
      setPendingFolderSelectionPath(null);
    }
  }, [pendingFolderSelectionPath, selectedBrowserEntryKey, setPendingFolderSelectionPath]);

  const selectedBrowserEntryIndex = useMemo(() => {
    if (!selectedBrowserEntryKey) {
      return -1;
    }

    return browserEntries.findIndexByKey(selectedBrowserEntryKey);
  }, [browserEntries, selectedBrowserEntryKey]);

  const selectedBrowserEntry = useMemo(() => {
    if (selectedBrowserEntryIndex < 0) {
      return null;
    }

    return browserEntries.at(selectedBrowserEntryIndex);
  }, [browserEntries, selectedBrowserEntryIndex]);

  const selectBrowserEntryAction = useCallback(
    (entry: BrowserEntry): void => {
      setSelectedBrowserEntryKey(entry.key);
      if (entry.kind === 'media') {
        setSelectedId(entry.media.id);
        return;
      }

      setSelectedId(null);
    },
    [setSelectedId],
  );

  const activateBrowserEntryAction = useCallback(
    (entry: BrowserEntry): void => {
      if (entry.kind === 'folder') {
        navigateToFolderAction(entry.path);
        return;
      }

      if (entry.kind === 'comic') {
        openComicReader(entry.comic);
        return;
      }

      openViewerAt(entry.mediaIndex);
    },
    [navigateToFolderAction, openComicReader, openViewerAt],
  );

  return {
    activateBrowserEntryAction,
    selectBrowserEntryAction,
    selectedBrowserEntry,
    selectedBrowserEntryIndex,
    selectedBrowserEntryKey,
  };
}
