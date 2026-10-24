import { type JSX, useEffect, useMemo, useState } from "react";

import { toDisplayName } from "../utils/path";
import { GalleryGrid } from "./components/GalleryGrid";
import { GalleryHeader } from "./components/GalleryHeader";
import { GalleryToolbar } from "./components/GalleryToolbar";
import type { LayoutShellProps } from "./LayoutShellProps";

/**
 * View's page: the top bar every mode has, the gallery grid, the folder browser over it, and the
 * floating bottom action bar.
 */
export function PrismLayout({
  settings,
  rootPath,
  scanMessage,
  scanMessagePath,
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
  onSelectFolder,
  onSelectBrowserEntry,
  onActivateBrowserEntry,
  onOpenParentFolder,
  onOpenPreviousFolder,
  onOpenNextFolder,
}: LayoutShellProps): JSX.Element {
  const [folderOverlayOpen, setFolderOverlayOpen] = useState(false);
  const [showReadyState, setShowReadyState] = useState(false);
  const isScanning = scanState === "loading";

  useEffect(() => {
    if (scanState === "done") {
      setShowReadyState(true);

      const timer = window.setTimeout(() => {
        setShowReadyState(false);
      }, 5000);

      return () => window.clearTimeout(timer);
    }

    setShowReadyState(false);

    return undefined;
  }, [scanMessage, scanState]);

  const showTopStatus =
    scanState === "loading" || scanState === "error" || (scanState === "done" && showReadyState);

  const folderName = useMemo(() => (rootPath ? toDisplayName(rootPath) : null), [rootPath]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-50 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
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
        folderName={folderName}
        mediaEntryCount={mediaEntryCount}
        selectedBrowserEntryIndex={selectedBrowserEntryIndex}
        topStatus={
          showTopStatus
            ? {
                kind: isScanning ? "scanning" : "ready",
                message: scanMessage,
                path: scanMessagePath,
              }
            : null
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
        excludesActive={excludedRootChildPaths.length > 0}
        hasRootFolder={rootPath !== null}
        isRefreshing={isScanning}
        onChangeSortMode={onChangeSortMode}
        onOpenFolder={onOpenFolder}
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
