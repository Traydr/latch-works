import type { JSX } from 'react';

interface GalleryHeaderProps {
  browserEntryCount: number;
  cacheStatusMessage: string | null;
  folderNavigation: {
    canGoToNextFolder: boolean;
    canGoToPreviousFolder: boolean;
    canOpenParentFolder: boolean;
    onOpenNextFolder: () => void;
    onOpenParentFolder: () => void;
    onOpenPreviousFolder: () => void;
  };
  comicEntryCount: number;
  currentFolderPathLabel: string;
  folderEntryCount: number;
  folderLabel: string;
  mediaEntryCount: number;
  rootPath: string | null;
  selectedBrowserEntryIndex: number;
  topStatus: { kind: 'ready' | 'scanning'; message: string } | null;
}

export function GalleryHeader({
  browserEntryCount,
  cacheStatusMessage,
  folderNavigation,
  comicEntryCount,
  currentFolderPathLabel,
  folderEntryCount,
  folderLabel,
  mediaEntryCount,
  rootPath,
  selectedBrowserEntryIndex,
  topStatus,
}: GalleryHeaderProps): JSX.Element {
  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-20 w-[min(96vw,1120px)] -translate-x-1/2">
      <header className="prism-surface pointer-events-auto flex flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold tracking-tight">{folderLabel}</p>
          {rootPath ? (
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {currentFolderPathLabel}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {topStatus ? (
            <span className="prism-pill">
              {topStatus.kind === 'scanning' ? (
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              ) : null}
              <span className="max-w-[28vw] truncate">{topStatus.message}</span>
            </span>
          ) : null}
          {cacheStatusMessage ? <span className="prism-pill">{cacheStatusMessage}</span> : null}
          {folderEntryCount > 0 ? (
            <span className="prism-pill tabular-nums">{folderEntryCount} folders</span>
          ) : null}
          {comicEntryCount > 0 ? (
            <span className="prism-pill tabular-nums">{comicEntryCount} comics</span>
          ) : (
            <span className="prism-pill tabular-nums">{mediaEntryCount} items</span>
          )}
          {selectedBrowserEntryIndex >= 0 ? (
            <span className="prism-pill tabular-nums">
              {selectedBrowserEntryIndex + 1}/{browserEntryCount}
            </span>
          ) : null}
          {rootPath ? (
            <>
              <button
                type="button"
                className={`prism-btn ${folderNavigation.canOpenParentFolder ? '' : 'pointer-events-none opacity-45'}`}
                onClick={folderNavigation.onOpenParentFolder}
                disabled={!folderNavigation.canOpenParentFolder}
              >
                Parent
              </button>
              <button
                type="button"
                className={`prism-btn ${folderNavigation.canGoToPreviousFolder ? '' : 'pointer-events-none opacity-45'}`}
                onClick={folderNavigation.onOpenPreviousFolder}
                disabled={!folderNavigation.canGoToPreviousFolder}
              >
                Prev Folder
              </button>
              <button
                type="button"
                className={`prism-btn ${folderNavigation.canGoToNextFolder ? '' : 'pointer-events-none opacity-45'}`}
                onClick={folderNavigation.onOpenNextFolder}
                disabled={!folderNavigation.canGoToNextFolder}
              >
                Next Folder
              </button>
            </>
          ) : null}
        </div>
      </header>
    </div>
  );
}
