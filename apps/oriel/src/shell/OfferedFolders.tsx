import { FolderOpen } from "lucide-react";

import { type KnownFolder, MODE_LABELS } from "../shared/shell";
import { baseName } from "./paths";

/** Which modes use a folder, as "View and Sync"; old apps' folders say so. */
function usedBy(folder: KnownFolder): string {
  const labels = folder.modes.map((mode) => MODE_LABELS[mode]);

  if (labels.length === 0) {
    return "From the old apps";
  }

  return `In ${labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0]}`;
}

/**
 * The folders the other modes work on, offered in a mode's empty state: one click starts this
 * mode on the same folder. Nothing shows when there are none.
 */
export function OfferedFolders({
  folders,
  onChoose,
  title = "Or one you already use",
}: {
  folders: readonly KnownFolder[];
  onChoose: (folder: KnownFolder) => void;
  title?: string;
}) {
  if (folders.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Folders from the other modes"
      className="mt-8 w-full max-w-[400px] text-left"
    >
      <h2 className="lw-caption mb-2 px-1 font-medium">{title}</h2>
      <ul className="lw-card divide-y lw-divider overflow-hidden">
        {folders.slice(0, 4).map((folder) => (
          <li key={folder.path}>
            <button
              type="button"
              className="lw-hover lw-focus flex w-full items-center gap-3 px-3.5 py-2.5 text-left"
              title={folder.path}
              data-offered-folder={folder.path}
              onClick={() => onChoose(folder)}
            >
              <FolderOpen className="size-4 shrink-0 text-zinc-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">
                  {baseName(folder.path)}
                </span>
                <span className="lw-caption block truncate">{usedBy(folder)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
