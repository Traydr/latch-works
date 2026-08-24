import { cn } from "@/lib/utils";

export interface ExcludableChildFolder {
  name: string;
  path: string;
}

interface FolderExcludeDialogProps {
  childFolders: readonly ExcludableChildFolder[];
  excludedChildPaths: readonly string[];
  onToggle: (path: string) => void;
}

/**
 * The lean exclude dialog (Plan 054, Decision 4): the current path's direct
 * child folders, each row a one-click Included/Excluded toggle that takes
 * effect immediately. No breadcrumbs, no browse-into. Rendered above the
 * toolbar's folder button in the sort menu's popover idiom.
 */
export function FolderExcludeDialog({
  childFolders,
  excludedChildPaths,
  onToggle,
}: FolderExcludeDialogProps) {
  const excluded = new Set(excludedChildPaths);

  return (
    <div
      className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 max-h-72 w-64 overflow-y-auto rounded-2xl border border-border bg-popover p-1 shadow-xl backdrop-blur-xl"
      role="menu"
    >
      {childFolders.map((folder) => {
        const isExcluded = excluded.has(folder.path);
        return (
          <button
            key={folder.path}
            type="button"
            role="menuitemcheckbox"
            aria-checked={isExcluded}
            className={cn(
              "flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-accent",
              isExcluded ? "text-muted-foreground" : "text-foreground",
            )}
            onClick={() => onToggle(folder.path)}
            title={folder.path}
          >
            <span className={cn("truncate", isExcluded && "line-through")}>{folder.name}</span>
            <span
              className={cn(
                "shrink-0",
                isExcluded
                  ? "text-red-500 dark:text-red-400"
                  : "text-violet-700 dark:text-violet-300",
              )}
            >
              {isExcluded ? "Excluded" : "Included"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
