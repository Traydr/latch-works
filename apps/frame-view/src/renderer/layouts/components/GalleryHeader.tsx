import { ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
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
  topStatus: { kind: 'ready' | 'scanning'; message: string; path: string | null } | null;
}

/**
 * One line of text that clips from the start, so a long path keeps its last segments (the
 * folder or file name) visible. The full text is in the tooltip.
 */
function StartTruncatedText({ className, text }: { className: string; text: string }) {
  return (
    <span className={`truncate text-left [direction:rtl] ${className}`} title={text}>
      <bdi dir="ltr">{text}</bdi>
    </span>
  );
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
      <header className="prism-surface pointer-events-auto flex items-center justify-between gap-3 px-4 py-2">
        <div className="flex min-w-24 flex-1 flex-col">
          <p
            className="truncate text-sm font-semibold tracking-tight"
            title={rootPath ?? undefined}
          >
            {folderLabel}
          </p>
          {rootPath ? (
            <StartTruncatedText
              className="text-xs text-zinc-500 dark:text-zinc-400"
              text={currentFolderPathLabel}
            />
          ) : null}
        </div>
        {/* Only the status pill shrinks, so the bar stays one line however long its path is. */}
        <div className="flex min-w-0 items-center gap-2">
          {topStatus ? (
            <span
              className="prism-pill min-w-0 max-w-[28vw]"
              title={topStatus.path ? `${topStatus.message}: ${topStatus.path}` : topStatus.message}
            >
              {topStatus.kind === 'scanning' ? (
                <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
              ) : null}
              {/* With a path, the message keeps its width up to 60% and the path gets the rest. */}
              <span className={`truncate ${topStatus.path ? 'max-w-[60%] shrink-0' : 'min-w-0'}`}>
                {topStatus.message}
              </span>
              {topStatus.path ? (
                <StartTruncatedText className="min-w-0" text={topStatus.path} />
              ) : null}
            </span>
          ) : null}
          {cacheStatusMessage ? (
            <span className="prism-pill shrink-0">{cacheStatusMessage}</span>
          ) : null}
          {folderEntryCount > 0 ? (
            <span className="prism-pill shrink-0 tabular-nums">{folderEntryCount} folders</span>
          ) : null}
          {comicEntryCount > 0 ? (
            <span className="prism-pill shrink-0 tabular-nums">{comicEntryCount} comics</span>
          ) : (
            <span className="prism-pill shrink-0 tabular-nums">{mediaEntryCount} items</span>
          )}
          {selectedBrowserEntryIndex >= 0 ? (
            <span className="prism-pill shrink-0 tabular-nums">
              {selectedBrowserEntryIndex + 1}/{browserEntryCount}
            </span>
          ) : null}
          {rootPath ? (
            <>
              <button
                type="button"
                className="prism-btn inline-flex shrink-0 items-center gap-2"
                onClick={folderNavigation.onOpenParentFolder}
                disabled={!folderNavigation.canOpenParentFolder}
                title="Open the parent folder"
              >
                <ArrowUp className="size-4" />
                Parent
              </button>
              <button
                type="button"
                className="prism-btn inline-flex shrink-0 items-center gap-2"
                onClick={folderNavigation.onOpenPreviousFolder}
                disabled={!folderNavigation.canGoToPreviousFolder}
                title="Open the previous sibling folder"
              >
                <ChevronLeft className="size-4" />
                Prev Folder
              </button>
              <button
                type="button"
                className="prism-btn inline-flex shrink-0 items-center gap-2"
                onClick={folderNavigation.onOpenNextFolder}
                disabled={!folderNavigation.canGoToNextFolder}
                title="Open the next sibling folder"
              >
                Next Folder
                <ChevronRight className="size-4" />
              </button>
            </>
          ) : null}
        </div>
      </header>
    </div>
  );
}
