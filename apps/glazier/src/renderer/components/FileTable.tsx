import type { AudioState, FileId, FileQuery, FileRow } from "@latch-works/glazier-core/contract";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { call, desktop, thumbnailUrl } from "../lib/api";
import { useEngine } from "../lib/engine-state";
import { codecLabel, formatBytes, formatDate, formatDuration, formatLabel } from "../lib/format";

const ROW_HEIGHT = 36;

const PAGE_SIZE = 200;

const OVERSCAN = 10;

export type FileFilter = Omit<FileQuery, "offset" | "limit">;

const AUDIO_LABELS = {
  none: "No track",
  silent: "Silent",
  sound: "Sound",
  unmeasured: "Not measured",
} as const satisfies Record<AudioState, string>;

export function describeDetails(row: FileRow): string {
  const parts: string[] = [];

  if (row.width !== null && row.height !== null) {
    parts.push(`${row.width}×${row.height}`);
  }

  if (row.kind === "video") {
    const codec = codecLabel(row.videoCodec);

    if (codec) {
      parts.push(codec);
    }

    if (row.durationMs !== null) {
      parts.push(formatDuration(row.durationMs));
    }
  } else if ((row.frames ?? 1) > 1) {
    parts.push(`${row.frames} frames`);
  }

  return parts.join(" · ");
}

export function Thumbnail({ row, size = 24 }: { row: FileRow; size?: number }) {
  const [failed, setFailed] = useState(false);

  const showable =
    (row.kind === "image" || row.kind === "video") && row.probeError === null && !failed;

  return showable ? (
    <img
      src={thumbnailUrl(row.absPath, Math.max(64, size * 2))}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-[4px] bg-zinc-200 object-cover dark:bg-zinc-800"
    />
  ) : (
    <span
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-[4px] bg-zinc-200 font-mono text-[8px] text-zinc-500 uppercase dark:bg-zinc-800"
    >
      {row.ext.slice(0, 4)}
    </span>
  );
}

interface FileTableProps {
  filter: FileFilter;
  selected: ReadonlySet<FileId>;
  onSelect: (next: Set<FileId>) => void;
  onTotals?: (totals: { total: number; bytes: number }) => void;
}

/**
 * Every file matching a filter, paged in from the engine as the list scrolls. A new filter or a
 * changed catalog remounts the list, which starts its pages over.
 */
export function FileTable(props: FileTableProps) {
  const { catalogVersion } = useEngine();

  return <FileList key={`${JSON.stringify(props.filter)}|${catalogVersion}`} {...props} />;
}

function FileList({ filter, selected, onSelect, onTotals }: FileTableProps) {
  const { report } = useEngine();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [pages, setPages] = useState<Map<number, FileRow[]>>(new Map());
  const [total, setTotal] = useState<number | null>(null);
  const requested = useRef(new Set<number>());
  const anchor = useRef<number | null>(null);

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

  const loadPage = useCallback(
    (page: number) => {
      if (requested.current.has(page)) {
        return;
      }

      requested.current.add(page);

      call("listFiles", { ...filter, offset: page * PAGE_SIZE, limit: PAGE_SIZE }).then(
        (result) => {
          setPages((current) => new Map(current).set(page, result.rows));
          setTotal(result.total);
          onTotals?.({ total: result.total, bytes: result.totalBytes });
        },
        (error: Error) => {
          requested.current.delete(page);
          report(error);
        },
      );
    },
    // A new `filter` object each render is harmless: requested pages are fetched once.
    [filter, onTotals, report],
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
      rows.push({ index, row: rowAt(index) });
    }

    return rows;
  }, [first, last, rowAt]);

  const handleClick = (index: number, row: FileRow, event: ReactMouseEvent) => {
    const next = new Set(event.metaKey || event.ctrlKey || event.shiftKey ? selected : []);

    if (event.shiftKey && anchor.current !== null) {
      const [from, to] = anchor.current < index ? [anchor.current, index] : [index, anchor.current];

      for (let position = from; position <= to; position += 1) {
        const ranged = rowAt(position);

        if (ranged) {
          next.add(ranged.id);
        }
      }
    } else if ((event.metaKey || event.ctrlKey) && selected.has(row.id)) {
      next.delete(row.id);
    } else {
      next.add(row.id);
      anchor.current = index;
    }

    onSelect(next);
  };

  const allLoadedIds = () => {
    const ids = new Set<FileId>();

    for (const rows of pages.values()) {
      for (const row of rows) {
        ids.add(row.id);
      }
    }

    return ids;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-[28px_minmax(0,3fr)_88px_minmax(0,1.6fr)_80px_92px_96px] items-center gap-2 border-b ls-divider px-3 py-1.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
        <input
          type="checkbox"
          aria-label="Select all loaded files"
          checked={
            total !== null &&
            total > 0 &&
            selected.size >= Math.min(total, allLoadedIds().size) &&
            selected.size > 0
          }
          onChange={(event) => onSelect(event.target.checked ? allLoadedIds() : new Set())}
        />
        <span>Name</span>
        <span>Format</span>
        <span>Details</span>
        <span className="text-right">Size</span>
        <span>Audio</span>
        <span>Modified</span>
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
              <div
                key={row.id}
                data-file-name={row.name}
                data-selected={selected.has(row.id)}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                className={`absolute inset-x-0 grid grid-cols-[28px_minmax(0,1fr)] items-center gap-2 border-b border-zinc-100 px-3 text-xs dark:border-zinc-900 ${
                  selected.has(row.id)
                    ? "bg-violet-500/10"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                }`}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${row.name}`}
                  checked={selected.has(row.id)}
                  onChange={(event) => {
                    const next = new Set(selected);

                    if (event.target.checked) {
                      next.add(row.id);
                    } else {
                      next.delete(row.id);
                    }

                    onSelect(next);
                  }}
                />
                {/* The row's click target: select (⌘ adds, ⇧ extends), double-click for Quick Look. */}
                <button
                  type="button"
                  aria-label={row.relPath}
                  onClick={(event) => handleClick(index, row, event)}
                  onDoubleClick={() => void desktop.quickLook(row.absPath)}
                  className="grid h-full cursor-default grid-cols-[minmax(0,3fr)_88px_minmax(0,1.6fr)_80px_92px_96px] items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Thumbnail row={row} />
                    <span className="min-w-0">
                      <span className="block truncate text-zinc-800 dark:text-zinc-100">
                        {row.name}
                      </span>
                      <span className="block truncate text-[10px] text-zinc-500">
                        {row.dir || "/"}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center gap-1 truncate">
                    {formatLabel(row.format)}
                    {row.extensionMismatch ? (
                      <span
                        title="The extension does not match the bytes"
                        className="text-amber-600"
                      >
                        ≠ .{row.ext}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-zinc-500">
                    {row.probeError ? "Won't decode" : describeDetails(row)}
                  </span>
                  <span className="tabular text-right">{formatBytes(row.size)}</span>
                  <span className="text-zinc-500">
                    {row.audioState ? AUDIO_LABELS[row.audioState] : ""}
                  </span>
                  <span className="tabular text-zinc-500">{formatDate(row.mtimeMs)}</span>
                </button>
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
