import type { GallerySortMode } from "@latch-works/media-domain";
import { ArrowUpDown, FolderMinus, ImageIcon, ListTree, RefreshCcw, Shuffle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type ExcludableChildFolder,
  FolderExcludeDialog,
} from "@/features/gallery/FolderExcludeDialog";
import { cn } from "@/lib/utils";

interface FloatingToolbarProps {
  /** Direct child folders of the current path, from the browse snapshot. */
  childFolders: readonly ExcludableChildFolder[];
  /** False while the snapshot still shows the folder being left (or a search); gates the auto-prune. */
  childFoldersAreCurrent: boolean;
  comicMode: boolean;
  currentPath: string;
  excludedChildPaths: readonly string[];
  isRefreshing: boolean;
  onChangeSortMode: (mode: GallerySortMode) => void;
  onExcludeDialogOpen: () => void;
  onRefresh: () => void;
  onToggleComicMode: () => void;
  onToggleExcludedChild: (path: string) => void;
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

export function FloatingToolbar({
  childFolders,
  childFoldersAreCurrent,
  comicMode,
  currentPath,
  excludedChildPaths,
  isRefreshing,
  onChangeSortMode,
  onExcludeDialogOpen,
  onRefresh,
  onToggleComicMode,
  onToggleExcludedChild,
  onToggleRecursive,
  recursive,
  recursiveDisabled = false,
  shuffle,
  sortMode,
}: FloatingToolbarProps) {
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [excludeDialogOpen, setExcludeDialogOpen] = useState(false);
  const activeLabel = SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? "Sort";

  // The exclude button exists only in recursive/comic mode (Plan 054,
  // Decision 4); leaving those modes must not leave a phantom open dialog
  // behind for the next time they are entered.
  const excludeButtonVisible = recursive || comicMode;
  useEffect(() => {
    if (!excludeButtonVisible) {
      setExcludeDialogOpen(false);
    }
  }, [excludeButtonVisible]);

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
        {excludeButtonVisible ? (
          <div className="relative">
            <Button
              aria-expanded={excludeDialogOpen}
              aria-haspopup="menu"
              className={cn(toolButtonClass(false), "relative", excludeDialogOpen && "bg-accent")}
              disabled={childFolders.length === 0}
              onClick={() => {
                const next = !excludeDialogOpen;
                if (next && childFoldersAreCurrent) {
                  onExcludeDialogOpen();
                }
                setExcludeDialogOpen(next);
              }}
              size="sm"
              title={
                childFolders.length === 0 ? "No subfolders to exclude" : "Exclude subfolders"
              }
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
            {excludeDialogOpen ? (
              <FolderExcludeDialog
                childFolders={childFolders}
                excludedChildPaths={excludedChildPaths}
                onToggle={onToggleExcludedChild}
              />
            ) : null}
          </div>
        ) : null}
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
