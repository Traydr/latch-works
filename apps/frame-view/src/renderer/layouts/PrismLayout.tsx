import { type JSX, useEffect, useMemo, useState } from 'react';

import { toDisplayName } from '../utils/path';
import { GalleryGrid } from './components/GalleryGrid';
import { GalleryHeader } from './components/GalleryHeader';
import { GalleryToolbar } from './components/GalleryToolbar';
import type { LayoutShellProps } from './LayoutShellProps';

/**
 * PRISM — Adaptive light/dark layout with folder grid overlay.
 * Center-screen modal shows subfolders as visual cards in a grid.
 * Masonry grid with rounded cards (Mosaic-style).
 * Floating bottom action bar.
 */
export function PrismLayout({
  settings,
  rootPath,
  scanMessage,
  scanState,
  recursive,
  comicMode,
  folderChildrenLoading,
  browserEntries,
  selectedBrowserEntryKey,
  selectedBrowserEntryIndex,
  comicEntryCount,
  excludedRootChildPaths,
  folderEntryCount,
  mediaEntryCount,
  currentFolderPathLabel,
  canOpenParentFolder,
  canGoToPreviousFolder,
  canGoToNextFolder,
  cacheStatusMessage,
  onOpenFolder,
  onRefresh,
  onToggleRecursive,
  onToggleComicMode,
  onToggleExcludedRootChild,
  onChangeSortMode,
  onShuffleRandom,
  onOpenSettings,
  onSelectFolder,
  onSelectBrowserEntry,
  onActivateBrowserEntry,
  onOpenParentFolder,
  onOpenPreviousFolder,
  onOpenNextFolder,
}: LayoutShellProps): JSX.Element {
  const [folderOverlayOpen, setFolderOverlayOpen] = useState(false);
  const [showReadyState, setShowReadyState] = useState(false);
  const isScanning = scanState === 'loading';

  useEffect(() => {
    if (scanState === 'done') {
      setShowReadyState(true);
      const timer = window.setTimeout(() => {
        setShowReadyState(false);
      }, 5000);
      return () => window.clearTimeout(timer);
    }

    setShowReadyState(false);
    return undefined;
  }, [scanMessage, scanState]);

  const topStatus = useMemo(() => {
    if (scanState === 'loading' || scanState === 'error') {
      return scanMessage;
    }

    if (scanState === 'done' && showReadyState) {
      return scanMessage;
    }

    return null;
  }, [scanMessage, scanState, showReadyState]);

  const folderLabel = useMemo(() => {
    if (!rootPath) {
      return 'Folder: none';
    }

    return `Folder: ${toDisplayName(rootPath)}`;
  }, [rootPath]);

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-zinc-50 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <GalleryHeader
        browserEntryCount={browserEntries.length}
        cacheStatusMessage={cacheStatusMessage}
        folderNavigation={{
          canGoToNextFolder,
          canGoToPreviousFolder,
          canOpenParentFolder,
          onOpenNextFolder,
          onOpenParentFolder,
          onOpenPreviousFolder,
        }}
        currentFolderPathLabel={currentFolderPathLabel}
        comicEntryCount={comicEntryCount}
        folderEntryCount={folderEntryCount}
        folderLabel={folderLabel}
        mediaEntryCount={mediaEntryCount}
        rootPath={rootPath}
        selectedBrowserEntryIndex={selectedBrowserEntryIndex}
        topStatus={
          topStatus ? { message: topStatus, kind: isScanning ? 'scanning' : 'ready' } : null
        }
      />

      <GalleryGrid
        browserEntries={browserEntries}
        comicMode={comicMode}
        excludedRootChildPaths={excludedRootChildPaths}
        folderChildrenLoading={folderChildrenLoading}
        folderOverlayOpen={folderOverlayOpen}
        onActivateBrowserEntry={onActivateBrowserEntry}
        onSelectBrowserEntry={onSelectBrowserEntry}
        onSelectFolder={onSelectFolder}
        onToggleExcludedRootChild={onToggleExcludedRootChild}
        rootPath={rootPath}
        selectedBrowserEntryKey={selectedBrowserEntryKey}
        setFolderOverlayOpen={setFolderOverlayOpen}
        settings={settings}
      />

      <GalleryToolbar
        onChangeSortMode={onChangeSortMode}
        onOpenFolder={onOpenFolder}
        onOpenSettings={onOpenSettings}
        onRefresh={onRefresh}
        onShuffleRandom={onShuffleRandom}
        onToggleFolderOverlay={() => setFolderOverlayOpen(true)}
        onToggleComicMode={onToggleComicMode}
        onToggleRecursive={onToggleRecursive}
        comicMode={comicMode}
        recursive={recursive}
        settings={settings}
      />
    </div>
  );
}
