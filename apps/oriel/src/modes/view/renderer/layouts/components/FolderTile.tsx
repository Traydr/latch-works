import { Folder } from "lucide-react";
import type { JSX } from "react";

import type { BrowserEntry } from "../../utils/browserEntries";

interface FolderTileProps {
  cardHeight: number;
  cardWidth: number;
  entry: Extract<BrowserEntry, { kind: "folder" }>;
  left: number;
  onActivate: (entry: BrowserEntry) => void;
  onSelect: (entry: BrowserEntry) => void;
  selected: boolean;
  top: number;
}

export function FolderTile({
  cardHeight,
  cardWidth,
  entry,
  left,
  onActivate,
  onSelect,
  selected,
  top,
}: FolderTileProps): JSX.Element {
  return (
    <button
      type="button"
      data-gallery-item="true"
      data-gallery-item-id={entry.key}
      className={`lw-focus group absolute flex flex-col justify-between overflow-hidden rounded-xl bg-white p-4 text-left shadow-[var(--shadow-border)] transition-[box-shadow,transform] duration-150 active:scale-[0.97] dark:bg-zinc-900 ${
        selected ? "ring-2 ring-violet-500" : "hover:shadow-[var(--shadow-border-hover)]"
      }`}
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onActivate(entry)}
      style={{
        width: `${cardWidth}px`,
        height: `${cardHeight}px`,
        left: `${left}px`,
        top: `${top}px`,
      }}
      title={entry.path}
    >
      <div className="flex items-start justify-between gap-3">
        <Folder className="size-9 text-amber-500" />
        <span className="lw-badge lw-badge-neutral">Folder</span>
      </div>
      <div className="space-y-1">
        <p className="line-clamp-2 text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
          {entry.name}
        </p>
      </div>
    </button>
  );
}
