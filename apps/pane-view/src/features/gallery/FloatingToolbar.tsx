import type { GallerySortMode } from "@latch-works/media-domain";
import { useRouter } from "@tanstack/react-router";
import { ArrowUpDown, ImageIcon, ListTree, LogOut, RefreshCcw, Shuffle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FloatingToolbarProps {
  comicMode: boolean;
  onChangeSortMode: (mode: GallerySortMode) => void;
  onToggleComicMode: () => void;
  onToggleRecursive: () => void;
  recursive: boolean;
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
  comicMode,
  onChangeSortMode,
  onToggleComicMode,
  onToggleRecursive,
  recursive,
  shuffle,
  sortMode,
}: FloatingToolbarProps) {
  const router = useRouter();
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const activeLabel = SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? "Sort";

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-20 -translate-x-1/2">
      <div className="pointer-events-auto flex max-w-[96vw] items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/95 px-3 py-2 shadow-lg">
        <Button
          aria-pressed={recursive}
          className={toolButtonClass(recursive)}
          onClick={onToggleRecursive}
          size="sm"
          title="Recursive browsing"
          type="button"
          variant={recursive ? "default" : "outline"}
        >
          <ListTree className="size-4" />
          <span className="hidden sm:inline">Recursive</span>
        </Button>
        <Button
          aria-pressed={comicMode}
          className={toolButtonClass(comicMode)}
          onClick={onToggleComicMode}
          size="sm"
          title="Comic grouping"
          type="button"
          variant={comicMode ? "default" : "outline"}
        >
          <ImageIcon className="size-4" />
          <span className="hidden sm:inline">Comic</span>
        </Button>
        <div className="relative">
          <Button
            aria-expanded={sortMenuOpen}
            aria-haspopup="menu"
            className={cn(toolButtonClass(false), sortMenuOpen && "bg-zinc-800")}
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
              className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-40 rounded-2xl border border-zinc-700/80 bg-zinc-900/90 p-1 shadow-xl backdrop-blur-xl"
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
                      "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition",
                      selected
                        ? "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
                        : "text-zinc-300 hover:bg-zinc-800",
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
        <Button
          aria-pressed={sortMode === "random"}
          className={toolButtonClass(sortMode === "random")}
          onClick={shuffle}
          size="sm"
          title={sortMode === "random" ? "Shuffle again" : "Random sort"}
          type="button"
          variant={sortMode === "random" ? "default" : "outline"}
        >
          <Shuffle className="size-4" />
          <span className="hidden sm:inline">Shuffle</span>
        </Button>
        <div className="h-5 w-px bg-zinc-800" />
        <Button
          className={toolButtonClass(false)}
          onClick={() => void router.invalidate()}
          size="sm"
          title="Refresh"
          type="button"
          variant="outline"
        >
          <RefreshCcw className="size-4" />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
        <form action="/api/auth/logout" method="post">
          <Button
            className={toolButtonClass(false)}
            size="sm"
            title="Sign out"
            type="submit"
            variant="outline"
          >
            <LogOut className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
