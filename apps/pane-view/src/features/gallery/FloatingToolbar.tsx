import type { GallerySortMode } from "@latch-works/media-domain";
import { useRouter } from "@tanstack/react-router";
import { ImageIcon, ListTree, LogOut, RefreshCcw, Shuffle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FloatingToolbarProps {
  comicMode: boolean;
  onToggleComicMode: () => void;
  onToggleRecursive: () => void;
  recursive: boolean;
  shuffle: () => void;
  sortMode: GallerySortMode;
}

function toolButtonClass(active: boolean): string {
  return cn(
    "h-9 gap-2 rounded-lg px-3",
    active && "border-primary bg-primary text-primary-foreground",
  );
}

export function FloatingToolbar({
  comicMode,
  onToggleComicMode,
  onToggleRecursive,
  recursive,
  shuffle,
  sortMode,
}: FloatingToolbarProps) {
  const router = useRouter();

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
