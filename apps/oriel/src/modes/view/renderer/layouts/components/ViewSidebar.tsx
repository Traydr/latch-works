import { ArrowUp, CornerLeftUp, Folder, FolderOpen } from "lucide-react";
import type { JSX } from "react";

import { baseName, parentOf } from "../../../../../shell/paths";
import { SettingsItem } from "../../../../../shell/SettingsItem";
import { useShell } from "../../../../../shell/shell";
import { StartTruncate } from "../../../../../ui/ui";
import type { FolderNode } from "../../../shared/types";

interface ViewSidebarProps {
  /** The folder the owner opened, above which View does not step. */
  openedFolderPath: string | null;
  /** The folder on screen, the opened one or one inside it, or null before one is open. */
  folderPath: string | null;
  subfolders: readonly FolderNode[];
  subfoldersLoading: boolean;
  parentFolderPath: string | null;
  canOpenParentFolder: boolean;
  onOpenFolder: () => void;
  onOpenParentFolder: () => void;
  onSelectFolder: (folderPath: string) => void;
}

/** A row's left padding at a depth of the folder tree, 14 px a level. */
function indent(depth: number) {
  return { paddingLeft: `${10 + depth * 14}px` };
}

/**
 * View's sidebar, as Tidy and Sync have theirs: the folder the owner opened, which opens another,
 * then where View is inside it as a short tree. The parent is a muted step up, the folder on
 * screen is the current row, and its subfolders sit indented beneath it. In rail form, Open and
 * Parent as icons.
 */
export function ViewSidebar({
  openedFolderPath,
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
  // The folder a step up, while View is inside the one the owner opened.
  const upward = canOpenParentFolder ? parentFolderPath : null;

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
        <div className="mt-auto pb-3">
          <SettingsItem />
        </div>
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
              {openedFolderPath ? baseName(openedFolderPath) : "No folder open"}
            </span>
            {openedFolderPath ? (
              <StartTruncate text={parentOf(openedFolderPath)} className="lw-caption block" />
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
            {upward ? (
              <li>
                <button
                  type="button"
                  className="lw-sidebar-item text-zinc-500 dark:text-zinc-400"
                  aria-label={`Up to ${baseName(upward)}`}
                  title={`Up to ${baseName(upward)}`}
                  data-sidebar-parent
                  onClick={onOpenParentFolder}
                >
                  <CornerLeftUp />
                  <span className="min-w-0 flex-1 truncate">{baseName(upward)}</span>
                </button>
              </li>
            ) : null}
            <li>
              <div
                className="lw-sidebar-item cursor-default"
                aria-current="true"
                style={indent(upward ? 1 : 0)}
                data-sidebar-current
              >
                <FolderOpen />
                <span className="min-w-0 flex-1 truncate">{baseName(folderPath)}</span>
              </div>
            </li>
            {subfolders.map((subfolder) => (
              <li key={subfolder.path}>
                <button
                  type="button"
                  className="lw-sidebar-item"
                  style={indent(upward ? 2 : 1)}
                  data-sidebar-folder={subfolder.name}
                  onClick={() => onSelectFolder(subfolder.path)}
                >
                  <Folder />
                  <span className="min-w-0 flex-1 truncate">{subfolder.name}</span>
                </button>
              </li>
            ))}
            {subfolders.length === 0 ? (
              <li className="lw-caption py-1.5" style={indent(upward ? 2 : 1)}>
                {subfoldersLoading ? "Looking for subfolders…" : "No subfolders"}
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
      <ul className="mt-auto space-y-0.5 px-2 pt-1 pb-3">
        <li>
          <SettingsItem />
        </li>
      </ul>
    </nav>
  );
}
