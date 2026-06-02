import type { JSX } from 'react';

import type { GallerySortMode } from '../../../shared/types';

const SORT_OPTIONS: { value: GallerySortMode; label: string }[] = [
  { value: 'name-asc', label: 'A-Z' },
  { value: 'name-desc', label: 'Z-A' },
  { value: 'date-newest', label: 'Newest' },
  { value: 'date-oldest', label: 'Oldest' },
  { value: 'random', label: 'Random' },
];

interface SortMenuProps {
  activeSortLabel: string;
  onChangeSortMode: (mode: GallerySortMode) => void;
  onToggleOpen: () => void;
  setSortMenuOpen: (open: boolean) => void;
  sortMenuOpen: boolean;
  sortMode: GallerySortMode;
}

export function SortMenu({
  activeSortLabel,
  onChangeSortMode,
  onToggleOpen,
  setSortMenuOpen,
  sortMenuOpen,
  sortMode,
}: SortMenuProps): JSX.Element {
  return (
    <>
      <button
        type="button"
        className={`prism-btn flex items-center gap-2 ${sortMenuOpen ? 'bg-zinc-200 dark:bg-zinc-700' : ''}`}
        onClick={onToggleOpen}
        aria-haspopup="menu"
        aria-expanded={sortMenuOpen}
      >
        {activeSortLabel}
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-3 w-3 transition-transform ${sortMenuOpen ? 'rotate-180' : ''}`}
        >
          <path d="M5.5 7.5 10 12l4.5-4.5" />
        </svg>
      </button>

      {sortMenuOpen ? (
        <div
          className="prism-surface absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-40 p-1"
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
                className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                  selected
                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
                    : 'text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-700'
                }`}
                onClick={() => {
                  onChangeSortMode(option.value);
                  setSortMenuOpen(false);
                }}
              >
                <span>{option.label}</span>
                {selected ? <span>•</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
