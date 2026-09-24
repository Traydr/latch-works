import { useCallback, useRef, useState } from "react";
import type { GalleryBrowseStorage } from "@/features/gallery/gallery-browse-storage";

export interface ExcludedChildPaths {
  /** The current path's excluded direct-child folders (Plan 054). */
  excludedChildPaths: readonly string[];
  /** Drop stored excludes not among the current path's live children (dialog open). */
  pruneExcludedChildren(livePaths: readonly string[]): void;
  toggleExcludedChild(childPath: string): void;
}

/**
 * Plan 054: the current path's exclude list, mirrored from storage. The
 * render-time adjust rehydrates it the moment the path changes; the toggle and
 * prune intents write through to storage and keep the mirror in step even when
 * a storage write fails silently.
 */
export function useExcludedChildPaths(
  path: string,
  storage: GalleryBrowseStorage,
): ExcludedChildPaths {
  const [excludes, setExcludes] = useState<{ list: string[]; path: string }>(() => ({
    list: storage.readExcludedChildPaths(path),
    path,
  }));

  if (excludes.path !== path) {
    setExcludes({ list: storage.readExcludedChildPaths(path), path });
  }

  const pathRef = useRef(path);
  pathRef.current = path;

  const toggleExcludedChild = useCallback(
    (childPath: string) => {
      const currentPath = pathRef.current;
      const stored = storage.readExcludedChildPaths(currentPath);

      const next = stored.includes(childPath)
        ? stored.filter((storedPath) => storedPath !== childPath)
        : [...stored, childPath];

      storage.writeExcludedChildPaths(currentPath, next);
      setExcludes({ list: next, path: currentPath });
    },
    [storage],
  );

  const pruneExcludedChildren = useCallback(
    (livePaths: readonly string[]) => {
      const currentPath = pathRef.current;
      const stored = storage.readExcludedChildPaths(currentPath);
      const live = new Set(livePaths);
      const pruned = stored.filter((storedPath) => live.has(storedPath));

      if (pruned.length === stored.length) {
        return;
      }

      storage.writeExcludedChildPaths(currentPath, pruned);
      setExcludes({ list: pruned, path: currentPath });
    },
    [storage],
  );

  return { excludedChildPaths: excludes.list, pruneExcludedChildren, toggleExcludedChild };
}
