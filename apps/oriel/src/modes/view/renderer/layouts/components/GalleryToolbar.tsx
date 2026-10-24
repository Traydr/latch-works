import {
  FolderOpen,
  Folders,
  ImageIcon,
  ListTree,
  RefreshCcw,
  Settings,
  Shuffle,
} from "lucide-react";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";

import type { AppSettings, GallerySortMode } from "../../../shared/types";
import { SortMenu } from "./SortMenu";

interface GalleryToolbarProps {
  /** The opened root has child folders excluded from recursive scans: Folders shows a dot. */
  excludesActive: boolean;
  /** Comic grouping and recursive browsing need an opened folder to act on. */
  hasRootFolder: boolean;
  isRefreshing: boolean;
  onChangeSortMode: (mode: GallerySortMode) => void;
  onOpenFolder: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onShuffleRandom: () => void;
  onToggleComicMode: (value: boolean) => void;
  onToggleFolderOverlay: () => void;
  onToggleRecursive: (value: boolean) => void;
  comicMode: boolean;
  recursive: boolean;
  settings: AppSettings;
}

/** A toolbar button; a toggle that is on keeps the neutral selection, as the sidebar's does. */
export function toolButtonClass(active = false): string {
  return `lw-btn lw-btn-ghost px-3 ${active ? "lw-selected text-zinc-900 dark:text-white" : ""}`;
}

const SEPARATOR = "mx-0.5 h-5 w-px shrink-0 bg-zinc-900/10 dark:bg-white/10";

export function GalleryToolbar({
  excludesActive,
  hasRootFolder,
  isRefreshing,
  onChangeSortMode,
  onOpenFolder,
  onOpenSettings,
  onRefresh,
  onShuffleRandom,
  onToggleComicMode,
  onToggleFolderOverlay,
  onToggleRecursive,
  comicMode,
  recursive,
  settings,
}: GalleryToolbarProps): JSX.Element {
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sortMenuOpen) {
      return undefined;
    }

    const onMouseDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && sortMenuRef.current?.contains(event.target)) {
        return;
      }

      setSortMenuOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSortMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [sortMenuOpen]);

  const activeSortLabel = useMemo(() => {
    const labels = {
      "name-asc": "A-Z",
      "name-desc": "Z-A",
      "date-newest": "Newest",
      "date-oldest": "Oldest",
      random: "Random",
    } satisfies Record<GallerySortMode, string>;

    return labels[settings.sortMode];
  }, [settings.sortMode]);

  return (
    <div className="lw-float absolute bottom-5 left-1/2 z-20 inline-flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 overflow-visible p-1.5">
      <button
        type="button"
        className={toolButtonClass()}
        onClick={onOpenFolder}
        title="Open a folder"
      >
        <FolderOpen />
        Open
      </button>
      <button
        type="button"
        className={`${toolButtonClass()} relative`}
        onClick={onToggleFolderOverlay}
        title={excludesActive ? "Browse subfolders (some are excluded)" : "Browse subfolders"}
      >
        <Folders />
        Folders
        {excludesActive ? (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 size-1.5 rounded-full bg-violet-500"
          />
        ) : null}
      </button>
      <div className={SEPARATOR} />
      <button
        type="button"
        aria-pressed={recursive}
        className={toolButtonClass(recursive)}
        disabled={!hasRootFolder}
        onClick={() => onToggleRecursive(!recursive)}
        title={hasRootFolder ? "Recursive browsing" : "Open a folder to enable recursive browsing"}
      >
        <ListTree />
        Recursive
      </button>
      <button
        type="button"
        aria-pressed={comicMode}
        className={toolButtonClass(comicMode)}
        disabled={!hasRootFolder}
        onClick={() => onToggleComicMode(!comicMode)}
        title={hasRootFolder ? "Comic grouping" : "Open a folder for comic grouping"}
      >
        <ImageIcon />
        Comic
      </button>
      <div ref={sortMenuRef} className="relative">
        <SortMenu
          activeSortLabel={activeSortLabel}
          onChangeSortMode={onChangeSortMode}
          onToggleOpen={() => setSortMenuOpen((open) => !open)}
          setSortMenuOpen={setSortMenuOpen}
          sortMenuOpen={sortMenuOpen}
          sortMode={settings.sortMode}
        />
      </div>
      {settings.sortMode === "random" ? (
        <button
          type="button"
          className={toolButtonClass()}
          onClick={onShuffleRandom}
          title="Shuffle again"
        >
          <Shuffle />
          Shuffle
        </button>
      ) : null}
      <div className={SEPARATOR} />
      <button
        type="button"
        className={toolButtonClass()}
        disabled={isRefreshing}
        onClick={onRefresh}
        title="Refresh"
      >
        <RefreshCcw className={isRefreshing ? "animate-spin" : ""} />
        {isRefreshing ? "Refreshing" : "Refresh"}
      </button>
      <div className={SEPARATOR} />
      <button
        type="button"
        className={toolButtonClass()}
        onClick={onOpenSettings}
        title="Preferences"
      >
        <Settings />
        Settings
      </button>
    </div>
  );
}
