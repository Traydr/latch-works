import { compareByName } from "@latch-works/media-domain";
import { useCallback, useMemo } from "react";
import type { ExcludeControlProps } from "@/features/gallery/FloatingToolbar";
import type { GalleryBrowseSession } from "@/features/gallery/useGalleryBrowse";
import type { GalleryBrowseState } from "@/features/gallery/useGalleryBrowseState";

export interface UseFolderNeighboursOptions {
  browse: Pick<
    GalleryBrowseState,
    | "excludedChildPaths"
    | "navigateToPath"
    | "path"
    | "pruneExcludedChildren"
    | "query"
    | "toggleExcludedChild"
  >;
  library: GalleryBrowseSession["library"];
  snapshotIsCurrent: boolean;
}

export interface FolderNeighbours {
  canNavigateSiblings: boolean;
  /** The current folder's children, for the toolbar's exclude control. */
  exclude: ExcludeControlProps;
  navigateSiblingFolder: (offset: -1 | 1) => void;
}

/** The folders around the current one: its excludable children and its siblings. */
export function useFolderNeighbours({
  browse,
  library,
  snapshotIsCurrent,
}: UseFolderNeighboursOptions): FolderNeighbours {
  const {
    excludedChildPaths,
    navigateToPath,
    path: displayPath,
    pruneExcludedChildren,
    query,
    toggleExcludedChild,
  } = browse;

  // The excludable set is the current path's direct child folders, straight
  // from the snapshot, in the gallery's natural name order (Plan 054). While
  // searching, the snapshot's folders are search matches rather than
  // children, so nothing is excludable. A stale snapshot (folder being left)
  // does NOT empty the list — collapsing it mid-interaction would blank the
  // open dialog and reset its scroll; instead the toolbar disables the button
  // until the children are current, and the dialog remounts per path.
  const excludableChildFolders = useMemo(
    () => (query ? [] : [...(library?.folders ?? [])].sort(compareByName)),
    [library, query],
  );

  const childFoldersAreCurrent = !query && snapshotIsCurrent && Boolean(library);

  const handleExcludeDialogOpen = useCallback(() => {
    pruneExcludedChildren(excludableChildFolders.map((folder) => folder.path));
  }, [excludableChildFolders, pruneExcludedChildren]);

  const exclude = useMemo(
    () => ({
      childFolders: excludableChildFolders,
      childFoldersAreCurrent,
      excludedChildPaths,
      onDialogOpen: handleExcludeDialogOpen,
      onToggle: toggleExcludedChild,
    }),
    [
      childFoldersAreCurrent,
      excludableChildFolders,
      excludedChildPaths,
      handleExcludeDialogOpen,
      toggleExcludedChild,
    ],
  );

  // The current folder's siblings (the snapshot's `siblings`, never its
  // `folders`, which are the children) in the gallery's natural name order,
  // the order the parent's grid shows them in. Until the snapshot belongs to
  // this browse, its siblings describe the folder being left; stepping
  // through them would move along an ordering the user cannot see selected,
  // so the list is empty and the buttons disable for that window.
  const siblingFolders = useMemo(
    () => (library && snapshotIsCurrent ? [...library.siblings].sort(compareByName) : []),
    [library, snapshotIsCurrent],
  );

  const canNavigateSiblings =
    siblingFolders.length > 1 && siblingFolders.some((folder) => folder.path === displayPath);

  const navigateSiblingFolder = useCallback(
    (offset: -1 | 1) => {
      const currentIndex = siblingFolders.findIndex((folder) => folder.path === displayPath);

      if (currentIndex < 0) {
        return;
      }

      const nextIndex = (currentIndex + offset + siblingFolders.length) % siblingFolders.length;
      const next = siblingFolders[nextIndex];

      if (next && next.path !== displayPath) {
        navigateToPath(next.path);
      }
    },
    [displayPath, navigateToPath, siblingFolders],
  );

  return { canNavigateSiblings, exclude, navigateSiblingFolder };
}
