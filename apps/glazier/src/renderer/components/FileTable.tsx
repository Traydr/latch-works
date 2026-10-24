import type { AudioState, FileId, FileQuery, FileRow } from "@latch-works/glazier-core/contract";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { call } from "../lib/api";
import { useEngine } from "../lib/engine-state";
import { formatBytes, formatDate, formatLabel } from "../lib/format";
import { isCommandKey, useViewKeys } from "../lib/hotkeys";
import { describeDetails, Thumbnail } from "./media";

const ROW_HEIGHT = 36;

const PAGE_SIZE = 200;

const OVERSCAN = 10;

export type FileListQuery = Omit<FileQuery, "offset" | "limit">;

type SortColumn = FileQuery["sort"];

const AUDIO_LABELS = {
  none: "No track",
  silent: "Silent",
  sound: "Sound",
  unmeasured: "Not measured",
} as const satisfies Record<AudioState, string>;

/** Columns whose first click sorts largest or newest first, as Finder does. */
const DESCENDING_FIRST = new Set<SortColumn>(["size", "mtime", "duration"]);

const COLUMNS = "grid-cols-[28px_minmax(0,3fr)_88px_minmax(0,1.6fr)_80px_92px_96px]";

interface FileTableProps {
  query: FileListQuery;
  selected: ReadonlySet<FileId>;
  onSelect: (next: Set<FileId>) => void;
  onSelectAll: () => void;
  onSort: (sort: SortColumn, descending: boolean) => void;
  onTotals?: (totals: { total: number; bytes: number }) => void;
  onOpen: (row: FileRow) => void;
  onQuickLook: (row: FileRow) => void;
  onContextMenu: (row: FileRow) => void;
  /** The file being renamed in place, if any. */
  renaming: FileId | null;
  onRenameStart: (row: FileRow) => void;
  onRenameEnd: (row: FileRow, name: string | null) => void;
}

/**
 * Every file matching a query, paged in from the engine as the list scrolls. A new query starts
 * over at the top; a changed catalog refreshes the loaded rows in place.
 */
export function FileTable(props: FileTableProps) {
  return <FileList key={JSON.stringify(props.query)} {...props} />;
}

function HeaderCell({
  label,
  column,
  query,
  onSort,
  align = "left",
}: {
  label: string;
  column: SortColumn | null;
  query: FileListQuery;
  onSort: (sort: SortColumn, descending: boolean) => void;
  align?: "left" | "right";
}) {
  if (column === null) {
    return <span className={align === "right" ? "text-right" : ""}>{label}</span>;
  }

  const active = query.sort === column;

  return (
    <button
      type="button"
      onClick={() => onSort(column, active ? !query.descending : DESCENDING_FIRST.has(column))}
      className={`flex items-center gap-1 uppercase hover:text-zinc-800 dark:hover:text-zinc-200 ${
        align === "right" ? "justify-end" : ""
      } ${active ? "text-zinc-800 dark:text-zinc-200" : ""}`}
    >
      {label}
      {active ? (
        query.descending ? (
          <ArrowDown className="size-3" />
        ) : (
          <ArrowUp className="size-3" />
        )
      ) : null}
    </button>
  );
}

function FileList({
  query,
  selected,
  onSelect,
  onSelectAll,
  onSort,
  onTotals,
  onOpen,
  onQuickLook,
  onContextMenu,
  renaming,
  onRenameStart,
  onRenameEnd,
}: FileTableProps) {
  const { report, catalogVersion } = useEngine();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [pages, setPages] = useState<Map<number, FileRow[]>>(new Map());
  const [total, setTotal] = useState<number | null>(null);
  const [focus, setFocus] = useState(0);
  /** Pages asked for in this generation; a catalog change starts a new one. */
  const requested = useRef(new Set<string>());
  const anchor = useRef<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const firstVersion = useRef(catalogVersion);

  useLayoutEffect(() => {
    const element = containerRef.current;

    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => setHeight(element.clientHeight));

    observer.observe(element);
    setHeight(element.clientHeight);

    return () => observer.disconnect();
  }, []);

  // A catalog change refetches the pages as they come into view, keeping the scroll position.
  useEffect(() => {
    if (catalogVersion !== firstVersion.current) {
      setGeneration((value) => value + 1);
    }
  }, [catalogVersion]);

  const loadPage = useCallback(
    (page: number) => {
      const key = `${generation}:${page}`;

      if (requested.current.has(key)) {
        return;
      }

      requested.current.add(key);

      call("listFiles", { ...query, offset: page * PAGE_SIZE, limit: PAGE_SIZE }).then(
        (result) => {
          setPages((current) => new Map(current).set(page, result.rows));
          setTotal(result.total);
          onTotals?.({ total: result.total, bytes: result.totalBytes });
        },
        (error: Error) => {
          requested.current.delete(key);
          report(error);
        },
      );
    },
    [query, onTotals, report, generation],
  );

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);

  const last = Math.min(
    total ?? PAGE_SIZE,
    Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN,
  );

  useEffect(() => {
    for (
      let page = Math.floor(first / PAGE_SIZE);
      page <= Math.floor(Math.max(first, last - 1) / PAGE_SIZE);
      page += 1
    ) {
      loadPage(page);
    }
  }, [first, last, loadPage]);

  const rowAt = useCallback(
    (index: number) => pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE] ?? null,
    [pages],
  );

  const visible = useMemo(() => {
    const rows: Array<{ index: number; row: FileRow | null }> = [];

    for (let index = first; index < last; index += 1) {
      rows.push({ index, row: index < (total ?? 0) ? rowAt(index) : null });
    }

    return rows;
  }, [first, last, rowAt, total]);

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

  const handleClick = (index: number, row: FileRow, event: ReactMouseEvent) => {
    setFocus(index);

    if (event.shiftKey && anchor.current !== null) {
      onSelect(selectRange(anchor.current, index, isCommandKey(event.nativeEvent) ? selected : []));

      return;
    }

    anchor.current = index;

    if (isCommandKey(event.nativeEvent)) {
      const next = new Set(selected);

      if (next.has(row.id)) {
        next.delete(row.id);
      } else {
        next.add(row.id);
      }

      onSelect(next);

      return;
    }

    onSelect(new Set([row.id]));
  };

  const scrollIntoView = (index: number) => {
    const element = containerRef.current;

    if (!element) {
      return;
    }

    const top = index * ROW_HEIGHT;

    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  };

  useViewKeys((event) => {
    if (total === null || total === 0 || event.metaKey || event.ctrlKey || event.altKey) {
      return false;
    }

    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const next = Math.max(0, Math.min(total - 1, focus + (event.key === "ArrowDown" ? 1 : -1)));
        const row = rowAt(next);

        setFocus(next);
        scrollIntoView(next);

        if (event.shiftKey) {
          anchor.current ??= focus;
          onSelect(selectRange(anchor.current, next, []));
        } else if (row) {
          anchor.current = next;
          onSelect(new Set([row.id]));
        }

        return true;
      }

      case " ": {
        const row = rowAt(focus);

        if (row) {
          onQuickLook(row);
        }

        return true;
      }

      case "Enter": {
        const row = rowAt(focus);

        if (row && selected.size <= 1) {
          onRenameStart(row);
        }

        return true;
      }

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

  const allSelected = total !== null && total > 0 && selected.size >= total;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={`grid ${COLUMNS} items-center gap-2 border-b ls-divider px-3 py-1.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase`}
      >
        <input
          type="checkbox"
          aria-label="Select every matching file"
          title="Select every matching file (⌘A)"
          className="accent-violet-600"
          checked={allSelected}
          onChange={(event) => (event.target.checked ? onSelectAll() : onSelect(new Set()))}
        />
        <HeaderCell label="Name" column="name" query={query} onSort={onSort} />
        <HeaderCell label="Format" column="kind" query={query} onSort={onSort} />
        <HeaderCell label="Details" column="duration" query={query} onSort={onSort} />
        <HeaderCell label="Size" column="size" query={query} onSort={onSort} align="right" />
        <HeaderCell label="Sound" column={null} query={query} onSort={onSort} />
        <HeaderCell label="Modified" column="mtime" query={query} onSort={onSort} />
      </div>

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-auto"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        data-testid="file-table"
      >
        {total === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">No files match.</p>
        ) : null}

        <div style={{ height: (total ?? 0) * ROW_HEIGHT }} className="relative">
          {visible.map(({ index, row }) =>
            row ? (
              // biome-ignore lint/a11y: virtualized rows sit absolutely positioned, which table rows cannot; the list handles keys for every row (useViewKeys).
              <div
                key={row.id}
                role="row"
                tabIndex={-1}
                aria-selected={selected.has(row.id)}
                data-file-name={row.name}
                data-selected={selected.has(row.id)}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                onClick={(event) => handleClick(index, row, event)}
                onDoubleClick={() => onOpen(row)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setFocus(index);

                  if (!selected.has(row.id)) {
                    anchor.current = index;
                    onSelect(new Set([row.id]));
                  }

                  onContextMenu(row);
                }}
                className={`absolute inset-x-0 grid ${COLUMNS} cursor-default items-center gap-2 border-b border-zinc-100 px-3 text-xs select-none dark:border-zinc-900 ${
                  selected.has(row.id)
                    ? "bg-violet-500/10"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                } ${index === focus ? "shadow-[inset_2px_0_0] shadow-violet-500" : ""}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${row.name}`}
                  className="accent-violet-600"
                  checked={selected.has(row.id)}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const next = new Set(selected);

                    if (event.target.checked) {
                      next.add(row.id);
                    } else {
                      next.delete(row.id);
                    }

                    anchor.current = index;
                    onSelect(next);
                  }}
                />
                <span className="flex min-w-0 items-center gap-2">
                  <Thumbnail row={row} />
                  <span className="min-w-0 flex-1">
                    {renaming === row.id ? (
                      <RenameField row={row} onDone={(name) => onRenameEnd(row, name)} />
                    ) : (
                      <span className="block truncate text-zinc-800 dark:text-zinc-100">
                        {row.name}
                      </span>
                    )}
                    <span className="block truncate text-[10px] text-zinc-500">
                      {row.dir || "/"}
                    </span>
                  </span>
                </span>
                <span className="flex items-center gap-1 truncate">
                  {formatLabel(row.format)}
                  {row.extensionMismatch ? (
                    <span title="The extension does not match the file" className="text-amber-600">
                      ≠ .{row.ext}
                    </span>
                  ) : null}
                </span>
                <span className="truncate text-zinc-500">
                  {row.probeError ? "Won't open" : describeDetails(row)}
                </span>
                <span className="tabular text-right">{formatBytes(row.size)}</span>
                <span className="text-zinc-500">
                  {row.audioState ? AUDIO_LABELS[row.audioState] : ""}
                </span>
                <span className="tabular text-zinc-500">{formatDate(row.mtimeMs)}</span>
              </div>
            ) : (
              <div
                key={`pending-${index}`}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                className="absolute inset-x-0 px-3"
              >
                <div className="mt-3 h-2.5 w-1/3 rounded bg-zinc-100 dark:bg-zinc-900" />
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** The name, editable in place: Return renames, Esc or clicking away keeps it. */
function RenameField({ row, onDone }: { row: FileRow; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(row.name);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    const element = input.current;

    if (element) {
      element.focus();

      const dot = row.name.lastIndexOf(".");

      element.setSelectionRange(0, dot > 0 ? dot : row.name.length);
    }
  }, [row.name]);

  const finish = (value: string | null) => {
    if (!finished.current) {
      finished.current = true;
      onDone(value);
    }
  };

  return (
    <input
      ref={input}
      aria-label={`New name for ${row.name}`}
      className="ls-input -my-0.5 h-[20px] px-1 py-0 text-xs"
      value={name}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => finish(null)}
      onKeyDown={(event) => {
        event.stopPropagation();

        if (event.key === "Enter") {
          finish(name.trim() && name.trim() !== row.name ? name.trim() : null);
        } else if (event.key === "Escape") {
          finish(null);
        }
      }}
    />
  );
}
