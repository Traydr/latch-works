import { ArrowUp, Folder, FolderOpen } from "lucide-react";
import type { JSX } from "react";

import { baseName, parentOf } from "../../../../../shell/paths";
import { useShell } from "../../../../../shell/shell";
import { StartTruncate } from "../../../../../ui/ui";
import type { FolderNode } from "../../../shared/types";

interface ViewSidebarProps {
  /** The folder on screen, or null before one is open. */
  folderPath: string | null;
  subfolders: readonly FolderNode[];
  subfoldersLoading: boolean;
  parentFolderPath: string | null;
  canOpenParentFolder: boolean;
  onOpenFolder: () => void;
  onOpenParentFolder: () => void;
  onSelectFolder: (folderPath: string) => void;
}

/**
 * View's sidebar, as Tidy and Sync have theirs: the folder on screen, which opens another, then
 * its parent and its subfolders to step through. In rail form, Open and Parent as icons.
 */
export function ViewSidebar({
  folderPath,
  subfolders,
  subfoldersLoading,
  parentFolderPath,
  canOpenParentFolder,
  onOpenFolder,
  onOpenParentFolder,
  onSelectFolder,
}: ViewSidebarProps): JSX.Element {
  const { rail, insetTitleBar } = useShell();

  // The rail's buttons, as Tidy's: 48 px in the 88 px macOS rail, 40 px elsewhere.
  const railButton = `lw-sidebar-item justify-center px-0 ${
    insetTitleBar ? "size-12 rounded-xl [&_svg]:size-[22px]" : "size-10 rounded-lg [&_svg]:size-5"
  }`;

  if (rail) {
    return (
      <nav aria-label="View" className="flex min-h-0 w-full flex-1 flex-col items-center">
        <ul className="flex flex-col items-center space-y-1">
          <li>
            <button
              type="button"
              className={railButton}
              aria-label="Open a folder"
              title="Open a folder  ⌘O"
              onClick={onOpenFolder}
            >
              <FolderOpen />
            </button>
          </li>
          <li>
            <button
              type="button"
              className={railButton}
              aria-label="Up to the parent folder"
              title={parentFolderPath ? `Up to ${baseName(parentFolderPath)}` : "Up a folder"}
              disabled={!canOpenParentFolder}
              onClick={onOpenParentFolder}
            >
              <ArrowUp />
            </button>
          </li>
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label="View" className="flex min-h-0 w-full flex-1 flex-col">
      <div className="px-2">
        <button
          type="button"
          onClick={onOpenFolder}
          title="Open a folder  ⌘O"
          className="flex h-[52px] w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-zinc-900/[0.05] dark:hover:bg-white/[0.05]"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white text-zinc-600 shadow-[var(--shadow-border)] dark:bg-white/[0.08] dark:text-zinc-300">
            <FolderOpen className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold">
              {folderPath ? baseName(folderPath) : "No folder open"}
            </span>
            {folderPath ? (
              <StartTruncate text={parentOf(folderPath)} className="lw-caption block" />
            ) : (
              <span className="lw-caption block truncate">Open one to see it</span>
            )}
          </span>
        </button>
      </div>

      {folderPath ? (
        <>
          <p className="px-[18px] pt-4 pb-1.5 text-xs font-medium text-zinc-500">Folders</p>
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {canOpenParentFolder && parentFolderPath ? (
              <li>
                <button
                  type="button"
                  className="lw-sidebar-item"
                  aria-label={`Up to ${baseName(parentFolderPath)}`}
                  onClick={onOpenParentFolder}
                >
                  <ArrowUp />
                  <span className="min-w-0 flex-1 truncate">{baseName(parentFolderPath)}</span>
                </button>
              </li>
            ) : null}
            {subfolders.map((subfolder) => (
              <li key={subfolder.path}>
                <button
                  type="button"
                  className="lw-sidebar-item"
                  data-sidebar-folder={subfolder.name}
                  onClick={() => onSelectFolder(subfolder.path)}
                >
                  <Folder />
                  <span className="min-w-0 flex-1 truncate">{subfolder.name}</span>
                </button>
              </li>
            ))}
            {subfolders.length === 0 ? (
              <li className="lw-caption px-2.5 py-1.5">
                {subfoldersLoading ? "Looking for subfolders…" : "No subfolders"}
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
    </nav>
  );
}
