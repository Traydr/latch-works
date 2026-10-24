import { ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import type { JSX } from "react";

import { TopBar } from "../../../../../ui/ui";

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
  /** The folder on screen's name, or null before one is open. */
  folderName: string | null;
  mediaEntryCount: number;
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

const BADGE = "lw-badge lw-badge-neutral shrink-0";

/**
 * View's top bar, the one Tidy and Sync have: the folder's name and where it is on the left; the
 * scan's status, what the folder holds and the folder steps on the right.
 */
export function GalleryHeader({
  browserEntryCount,
  cacheStatusMessage,
  folderNavigation,
  comicEntryCount,
  currentFolderPathLabel,
  folderEntryCount,
  folderName,
  mediaEntryCount,
  selectedBrowserEntryIndex,
  topStatus,
}: GalleryHeaderProps): JSX.Element {
  return (
    <TopBar
      title={folderName ?? "View"}
      meta={
        folderName ? <StartTruncatedText className="block" text={currentFolderPathLabel} /> : null
      }
    >
      {topStatus ? (
        <span
          className="lw-badge lw-badge-neutral min-w-0 max-w-[24vw] gap-1.5"
          title={topStatus.path ? `${topStatus.message}: ${topStatus.path}` : topStatus.message}
        >
          {topStatus.kind === "scanning" ? (
            <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
          ) : null}
          {/* With a path, the message keeps its width up to 60% and the path gets the rest. */}
          <span className={`truncate ${topStatus.path ? "max-w-[60%] shrink-0" : "min-w-0"}`}>
            {topStatus.message}
          </span>
          {topStatus.path ? <StartTruncatedText className="min-w-0" text={topStatus.path} /> : null}
        </span>
      ) : null}
      {cacheStatusMessage ? <span className={BADGE}>{cacheStatusMessage}</span> : null}
      {folderEntryCount > 0 ? <span className={BADGE}>{folderEntryCount} folders</span> : null}
      {comicEntryCount > 0 ? (
        <span className={BADGE}>{comicEntryCount} comics</span>
      ) : (
        <span className={BADGE}>{mediaEntryCount} items</span>
      )}
      {selectedBrowserEntryIndex >= 0 ? (
        <span className={BADGE}>
          {selectedBrowserEntryIndex + 1}/{browserEntryCount}
        </span>
      ) : null}
      {folderName ? (
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
    </TopBar>
  );
}
