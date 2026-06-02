import type { JSX } from 'react';

import type { BrowserEntry } from '../../utils/browserEntries';

interface FolderTileProps {
  cardHeight: number;
  cardWidth: number;
  entry: Extract<BrowserEntry, { kind: 'folder' }>;
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
      className={`group absolute flex flex-col justify-between overflow-hidden rounded-2xl border p-4 text-left transition-all ${
        selected
          ? 'border-violet-400 bg-violet-50/90 ring-2 ring-violet-400/70 dark:border-violet-500 dark:bg-violet-500/15'
          : 'border-zinc-300/80 bg-white/75 hover:-translate-y-0.5 hover:border-zinc-400 hover:bg-white hover:shadow-lg dark:border-zinc-700/80 dark:bg-zinc-900/75 dark:hover:border-zinc-600 dark:hover:bg-zinc-900'
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
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-10 w-10 text-amber-500 transition group-hover:scale-105"
        >
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
          FOLDER
        </span>
      </div>
      <div className="space-y-1">
        <p className="line-clamp-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          {entry.name}
        </p>
      </div>
    </button>
  );
}
