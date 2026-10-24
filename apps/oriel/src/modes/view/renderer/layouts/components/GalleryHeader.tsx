import { ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import type { JSX } from "react";

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
  topStatus: { kind: "ready" | "scanning"; message: string; path: string | null } | null;
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
    <div className="pointer-events-none absolute top-3 left-1/2 z-20 w-[min(calc(100%-2rem),1120px)] -translate-x-1/2">
      <header className="lw-drag lw-float pointer-events-auto flex items-center justify-between gap-3 py-2 pr-2 pl-4">
        <div className="flex min-w-24 flex-1 flex-col">
          <p className="truncate text-[13px] font-semibold" title={rootPath ?? undefined}>
            {folderLabel}
          </p>
          {rootPath ? (
            <StartTruncatedText className="lw-caption" text={currentFolderPathLabel} />
          ) : null}
        </div>
        {/* Only the status pill shrinks, so the bar stays one line however long its path is. */}
        <div className="flex min-w-0 items-center gap-2">
          {topStatus ? (
            <span
              className="lw-badge lw-badge-neutral min-w-0 max-w-[28vw] gap-1.5"
              title={topStatus.path ? `${topStatus.message}: ${topStatus.path}` : topStatus.message}
            >
              {topStatus.kind === "scanning" ? (
                <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
              ) : null}
              {/* With a path, the message keeps its width up to 60% and the path gets the rest. */}
              <span className={`truncate ${topStatus.path ? "max-w-[60%] shrink-0" : "min-w-0"}`}>
                {topStatus.message}
              </span>
              {topStatus.path ? (
                <StartTruncatedText className="min-w-0" text={topStatus.path} />
              ) : null}
            </span>
          ) : null}
          {cacheStatusMessage ? (
            <span className="lw-badge lw-badge-neutral shrink-0">{cacheStatusMessage}</span>
          ) : null}
          {folderEntryCount > 0 ? (
            <span className="lw-badge lw-badge-neutral shrink-0">{folderEntryCount} folders</span>
          ) : null}
          {comicEntryCount > 0 ? (
            <span className="lw-badge lw-badge-neutral shrink-0">{comicEntryCount} comics</span>
          ) : (
            <span className="lw-badge lw-badge-neutral shrink-0">{mediaEntryCount} items</span>
          )}
          {selectedBrowserEntryIndex >= 0 ? (
            <span className="lw-badge lw-badge-neutral shrink-0">
              {selectedBrowserEntryIndex + 1}/{browserEntryCount}
            </span>
          ) : null}
          {rootPath ? (
            <>
              <button
                type="button"
                className="lw-btn lw-btn-ghost lw-btn-sm"
                onClick={folderNavigation.onOpenParentFolder}
                disabled={!folderNavigation.canOpenParentFolder}
                title="Open the parent folder"
              >
                <ArrowUp />
                Parent
              </button>
              <button
                type="button"
                className="lw-btn lw-btn-ghost lw-btn-sm"
                onClick={folderNavigation.onOpenPreviousFolder}
                disabled={!folderNavigation.canGoToPreviousFolder}
                title="Open the previous sibling folder"
              >
                <ChevronLeft />
                Prev Folder
              </button>
              <button
                type="button"
                className="lw-btn lw-btn-ghost lw-btn-sm"
                onClick={folderNavigation.onOpenNextFolder}
                disabled={!folderNavigation.canGoToNextFolder}
                title="Open the next sibling folder"
              >
                Next Folder
                <ChevronRight />
              </button>
            </>
          ) : null}
        </div>
      </header>
    </div>
  );
}
