import type { FileId, FileRow } from "@latch-works/glazier-core/contract";
import { type MouseEvent as ReactMouseEvent, useRef } from "react";

import { isCommandKey, useViewKeys } from "../../lib/hotkeys";
import type { FilePages } from "./use-file-pages";

/** What the list and the grid share: the files, the selection, the cursor and what rows do. */
export interface FileViewProps {
  pages: FilePages;
  selected: ReadonlySet<FileId>;
  onSelect: (next: Set<FileId>) => void;
  /** The keyboard cursor's position, or null before the first click or key. */
  cursor: number | null;
  onCursor: (index: number) => void;
  onOpen: (row: FileRow) => void;
  onQuickLook: (row: FileRow) => void;
  onContextMenu: (row: FileRow) => void;
  /** The file being renamed in place, if any. */
  renaming: FileId | null;
  onRenameStart: (row: FileRow) => void;
  onRenameEnd: (row: FileRow, name: string | null) => void;
  /** Room the floating selection bar covers at the bottom, so the cursor never hides under it. */
  bottomInset: number;
}

interface FileCursorOptions extends FileViewProps {
  /** Files per line: 1 in the list, the column count in the grid. */
  columns: number;
  /** Scrolls the file at `index` into view. */
  reveal: (index: number) => void;
}

/**
 * Finder's selection model over a paged file list: a click selects one file, ⌘ toggles, ⇧
 * extends from the anchor; the arrows move the cursor (←/→ too in the grid), Space opens Quick
 * Look, Return renames and Esc clears.
 */
export function useFileCursor({
  pages,
  selected,
  onSelect,
  cursor,
  onCursor,
  onQuickLook,
  onContextMenu,
  renaming,
  onRenameStart,
  columns,
  reveal,
}: FileCursorOptions) {
  const anchor = useRef<number | null>(null);
  const { total, rowAt } = pages;

  const selectRange = (from: number, to: number, base: Iterable<FileId>) => {
    const next = new Set(base);
    const [low, high] = from < to ? [from, to] : [to, from];

    for (let position = low; position <= high; position += 1) {
      const ranged = rowAt(position);

      if (ranged) {
        next.add(ranged.id);
      }
    }

    return next;
  };

  const click = (index: number, row: FileRow, event: ReactMouseEvent) => {
    onCursor(index);

    if (event.shiftKey && anchor.current !== null) {
      onSelect(selectRange(anchor.current, index, isCommandKey(event.nativeEvent) ? selected : []));

      return;
    }

    anchor.current = index;

    if (isCommandKey(event.nativeEvent)) {
      toggle(index, row, !selected.has(row.id));

      return;
    }

    onSelect(new Set([row.id]));
  };

  const toggle = (index: number, row: FileRow, on: boolean) => {
    const next = new Set(selected);

    if (on) {
      next.add(row.id);
    } else {
      next.delete(row.id);
    }

    anchor.current = index;
    onSelect(next);
  };

  const contextMenu = (index: number, row: FileRow, event: ReactMouseEvent) => {
    event.preventDefault();
    onCursor(index);

    if (!selected.has(row.id)) {
      anchor.current = index;
      onSelect(new Set([row.id]));
    }

    onContextMenu(row);
  };

  const move = (delta: number, extend: boolean) => {
    if (total === null || total === 0) {
      return;
    }

    const next = cursor === null ? 0 : Math.max(0, Math.min(total - 1, cursor + delta));
    const row = rowAt(next);

    onCursor(next);
    reveal(next);

    if (extend) {
      anchor.current ??= cursor ?? next;
      onSelect(selectRange(anchor.current, next, []));
    } else if (row) {
      anchor.current = next;
      onSelect(new Set([row.id]));
    }
  };

  useViewKeys((event) => {
    if (total === null || total === 0 || event.metaKey || event.ctrlKey || event.altKey) {
      return false;
    }

    const current = cursor === null ? null : rowAt(cursor);

    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        move(event.key === "ArrowDown" ? columns : -columns, event.shiftKey);

        return true;
      case "ArrowRight":
      case "ArrowLeft":
        if (columns === 1) {
          return false;
        }

        move(event.key === "ArrowRight" ? 1 : -1, event.shiftKey);

        return true;
      case " ":
        if (current) {
          onQuickLook(current);
        }

        return true;
      case "Enter":
        if (current && selected.size <= 1) {
          onRenameStart(current);
        }

        return true;
      case "Escape":
        if (selected.size > 0) {
          onSelect(new Set());

          return true;
        }

        return false;
      default:
        return false;
    }
  }, renaming === null);

  return { click, toggle, contextMenu };
}

/** The first and last (exclusive) indexes worth rendering for a scroll position, with overscan. */
export function visibleRange(
  scrollTop: number,
  height: number,
  lineHeight: number,
  columns: number,
  total: number | null,
) {
  const overscan = Math.max(2, Math.ceil(400 / lineHeight));
  const firstLine = Math.max(0, Math.floor(scrollTop / lineHeight) - overscan);
  const lastLine = Math.ceil((scrollTop + height) / lineHeight) + overscan;

  return {
    first: firstLine * columns,
    last: Math.min(total ?? lastLine * columns, lastLine * columns),
  };
}
