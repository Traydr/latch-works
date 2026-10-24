import { ArrowUpDown, Check, ChevronUp } from "lucide-react";
import type { JSX } from "react";

import type { GallerySortMode } from "../../../shared/types";
import { toolButtonClass } from "./GalleryToolbar";

const SORT_OPTIONS: { value: GallerySortMode; label: string }[] = [
  { value: "name-asc", label: "A-Z" },
  { value: "name-desc", label: "Z-A" },
  { value: "date-newest", label: "Newest" },
  { value: "date-oldest", label: "Oldest" },
  { value: "random", label: "Random" },
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
        className={toolButtonClass(sortMenuOpen)}
        onClick={onToggleOpen}
        aria-haspopup="menu"
        aria-expanded={sortMenuOpen}
        title="Sort"
      >
        <ArrowUpDown />
        {activeSortLabel}
        <ChevronUp
          className={`opacity-50 transition-transform ${sortMenuOpen ? "rotate-180" : ""}`}
        />
      </button>

      {sortMenuOpen ? (
        <div
          className="lw-menu absolute bottom-[calc(100%+0.75rem)] left-0 min-w-44 origin-bottom-left"
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
                className="lw-menu-item justify-between"
                onClick={() => {
                  onChangeSortMode(option.value);
                  setSortMenuOpen(false);
                }}
              >
                <span>{option.label}</span>
                <Check
                  className={`size-3.5 text-violet-600 dark:text-violet-400 ${selected ? "" : "invisible"}`}
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
