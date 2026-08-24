import type { GallerySortMode } from "@latch-works/media-domain";
import { ArrowUpDown, FolderMinus, ImageIcon, ListTree, RefreshCcw, Shuffle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type ExcludableChildFolder,
  FolderExcludeDialog,
} from "@/features/gallery/FolderExcludeDialog";
import { cn } from "@/lib/utils";

/** Everything the exclude button and its dialog need (Plan 054). */
export interface ExcludeControlProps {
  /** Direct child folders of the current path, from the browse snapshot. */
  childFolders: readonly ExcludableChildFolder[];
  /** False while the snapshot still shows the folder being left (or a search). */
  childFoldersAreCurrent: boolean;
  excludedChildPaths: readonly string[];
  /** Fires when the dialog opens against current children: the auto-prune hook. */
  onDialogOpen: () => void;
  onToggle: (path: string) => void;
}

interface FloatingToolbarProps {
  comicMode: boolean;
  currentPath: string;
  exclude: ExcludeControlProps;
  isRefreshing: boolean;
  onChangeSortMode: (mode: GallerySortMode) => void;
  onRefresh: () => void;
  onToggleComicMode: () => void;
  onToggleRecursive: () => void;
  recursive: boolean;
  recursiveDisabled?: boolean;
  shuffle: () => void;
  sortMode: GallerySortMode;
}

const SORT_OPTIONS: { value: GallerySortMode; label: string }[] = [
  { value: "name-asc", label: "A-Z" },
  { value: "name-desc", label: "Z-A" },
  { value: "date-newest", label: "Newest" },
  { value: "date-oldest", label: "Oldest" },
  { value: "random", label: "Random" },
];

function toolButtonClass(active: boolean): string {
  return cn(
    "h-9 gap-2 rounded-lg px-3",
    active && "border-primary bg-primary text-primary-foreground",
  );
}

/**
 * The exclude button and its dialog (Plan 054, Decisions 4–5). Mounted only
 * in recursive/comic mode and keyed by browse path, so leaving those modes or
 * navigating drops the open state with the component — no effect needed.
 * The button waits for the snapshot's children to be current: the snapshot's
 * rows linger through a navigation, and enabling on the old folder's children
 * would open the wrong list (and prune against it).
 */
function ExcludeControl({
  childFolders,
  childFoldersAreCurrent,
  excludedChildPaths,
  onDialogOpen,
  onToggle,
}: ExcludeControlProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const available = childFoldersAreCurrent && childFolders.length > 0;
  // Losing the excludable set (a search, a folder with no children) closes
  // the dialog for good; the next click must open, not toggle a stale flag.
  if (dialogOpen && !available) {
    setDialogOpen(false);
  }
  const showDialog = dialogOpen && available;

  return (
    <div className="relative">
      <Button
        aria-expanded={showDialog}
        aria-haspopup="menu"
        className={cn(toolButtonClass(false), "relative", showDialog && "bg-accent")}
        disabled={!available}
        onClick={() => {
          if (!dialogOpen) {
            onDialogOpen();
          }
          setDialogOpen(!dialogOpen);
        }}
        size="sm"
        title={childFolders.length === 0 ? "No subfolders to exclude" : "Exclude subfolders"}
        type="button"
        variant="outline"
      >
        <FolderMinus className="size-4" />
        <span className="hidden sm:inline">Exclude</span>
        {excludedChildPaths.length > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 size-2 rounded-full bg-primary"
          />
        ) : null}
      </Button>
      {showDialog ? (
        <FolderExcludeDialog
          childFolders={childFolders}
          excludedChildPaths={excludedChildPaths}
          onToggle={onToggle}
        />
      ) : null}
    </div>
  );
}

export function FloatingToolbar({
  comicMode,
  currentPath,
  exclude,
  isRefreshing,
  onChangeSortMode,
  onRefresh,
  onToggleComicMode,
  onToggleRecursive,
  recursive,
  recursiveDisabled = false,
  shuffle,
  sortMode,
}: FloatingToolbarProps) {
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const activeLabel = SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? "Sort";

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-20 -translate-x-1/2">
      <div className="pointer-events-auto flex max-w-[96vw] items-center gap-2 rounded-xl border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-sm">
        <Button
          aria-pressed={recursive}
          className={toolButtonClass(recursive)}
          disabled={recursiveDisabled}
          onClick={onToggleRecursive}
          size="sm"
          title={
            recursiveDisabled ? "Open a folder to enable recursive browsing" : "Recursive browsing"
          }
          type="button"
          variant={recursive ? "default" : "outline"}
        >
          <ListTree className="size-4" />
          <span className="hidden sm:inline">Recursive</span>
        </Button>
        <Button
          aria-pressed={comicMode}
          className={toolButtonClass(comicMode)}
          disabled={currentPath === ""}
          onClick={onToggleComicMode}
          size="sm"
          title={currentPath === "" ? "Open a folder for comic grouping" : "Comic grouping"}
          type="button"
          variant={comicMode ? "default" : "outline"}
        >
          <ImageIcon className="size-4" />
          <span className="hidden sm:inline">Comic</span>
        </Button>
        {recursive || comicMode ? <ExcludeControl key={currentPath} {...exclude} /> : null}
        <div className="relative">
          <Button
            aria-expanded={sortMenuOpen}
            aria-haspopup="menu"
            className={cn(toolButtonClass(false), sortMenuOpen && "bg-accent")}
            onClick={() => setSortMenuOpen((v) => !v)}
            size="sm"
            title="Sort"
            type="button"
            variant="outline"
          >
            <ArrowUpDown className="size-4" />
            <span className="hidden sm:inline">{activeLabel}</span>
          </Button>
          {sortMenuOpen ? (
            <div
              className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-40 rounded-2xl border border-border bg-popover p-1 shadow-xl backdrop-blur-xl"
              role="menu"
            >
              {SORT_OPTIONS.map((option) => {
                const selected = option.value === sortMode;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={cn(
                      "flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition",
                      selected
                        ? "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
                        : "text-foreground hover:bg-accent",
                    )}
                    onClick={() => {
                      onChangeSortMode(option.value);
                      setSortMenuOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {selected ? <span className="text-violet-400">•</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {sortMode === "random" ? (
          <Button
            className={toolButtonClass(false)}
            onClick={shuffle}
            size="sm"
            title="Shuffle again"
            type="button"
            variant="outline"
          >
            <Shuffle className="size-4" />
            <span className="hidden sm:inline">Shuffle</span>
          </Button>
        ) : null}
        <div className="h-5 w-px bg-border" />
        <Button
          className={toolButtonClass(false)}
          disabled={isRefreshing}
          onClick={onRefresh}
          size="sm"
          title="Refresh"
          type="button"
          variant="outline"
        >
          <RefreshCcw className={cn("size-4", isRefreshing && "animate-spin")} />
          <span className="hidden sm:inline">{isRefreshing ? "Refreshing" : "Refresh"}</span>
        </Button>
      </div>
    </div>
  );
}
