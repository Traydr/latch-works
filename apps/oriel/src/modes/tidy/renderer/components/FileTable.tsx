import type { FileQuery, FileRow } from "@latch-works/glazier-core/contract";
import { ArrowDown, ArrowUp, VolumeX } from "lucide-react";
import { useEffect, useMemo } from "react";
import { StartTruncate } from "../../../../ui/ui";
import { formatBytes, formatDate, formatDuration, formatLabel } from "../lib/format";
import { AUDIO_LABELS, isMuteVideo } from "./library/labels";
import { RenameField } from "./library/RenameField";
import { type FileViewProps, useFileCursor, visibleRange } from "./library/use-file-cursor";
import { useScrollBox } from "./library/use-scroll-box";
import { Thumbnail } from "./media";

const ROW_HEIGHT = 44;

const HEADER_HEIGHT = 32;

type SortColumn = FileQuery["sort"];

/** Columns whose first click sorts largest, newest or longest first, as Finder does. */
const DESCENDING_FIRST = new Set<SortColumn>(["size", "mtime", "duration"]);

/** Narrow panes drop Modified first, then Dimensions, so the name keeps room to read. */
function columnsFor(width: number) {
  const modified = width >= 760;
  const dimensions = width >= 620;

  return {
    template: [
      "16px",
      "minmax(0,1fr)",
      "88px",
      dimensions ? "112px" : null,
      "88px",
      modified ? "128px" : null,
    ]
      .flatMap((column) => (column ? [column] : []))
      .join(" "),
    dimensions,
    modified,
  };
}

interface FileTableProps extends FileViewProps {
  sort: SortColumn;
  descending: boolean;
  onSort: (sort: SortColumn, descending: boolean) => void;
  onSelectAll: () => void;
  /** The root's name, shown as the folder of files at its top. */
  rootName: string;
}

/** The Library's list: 44 px rows, paged in from the engine as the list scrolls. */
export function FileTable(props: FileTableProps) {
  const { pages, selected, cursor, renaming, sort, descending, onSort, bottomInset } = props;
  const box = useScrollBox();
  const { total, rowAt, request } = pages;
  const { first, last } = visibleRange(box.scrollTop, box.height, ROW_HEIGHT, 1, total);
  const columns = columnsFor(box.width);

  useEffect(() => request(first, last), [first, last, request]);

  const cursorKeys = useFileCursor({
    ...props,
    columns: 1,
    reveal: (index) =>
      box.show(
        HEADER_HEIGHT + index * ROW_HEIGHT,
        HEADER_HEIGHT + (index + 1) * ROW_HEIGHT,
        HEADER_HEIGHT,
        bottomInset,
      ),
  });

  const visible = useMemo(() => {
    const rows: Array<{ index: number; row: FileRow | null }> = [];

    for (let index = first; index < Math.min(last, total ?? 0); index += 1) {
      rows.push({ index, row: rowAt(index) });
    }

    return rows;
  }, [first, last, rowAt, total]);

  const choosing = selected.size > 0;
  const allSelected = total !== null && total > 0 && selected.size >= total;

  const header = (label: string, column: SortColumn, align: "left" | "right" = "left") => {
    const active = sort === column;
    const Arrow = descending ? ArrowDown : ArrowUp;

    return (
      <button
        type="button"
        onClick={() => onSort(column, active ? !descending : DESCENDING_FIRST.has(column))}
        className={`lw-focus flex h-full min-w-0 items-center gap-1 rounded-md hover:text-zinc-800 dark:hover:text-zinc-200 ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-zinc-800 dark:text-zinc-200" : ""}`}
      >
        <span className="truncate">{label}</span>
        {active ? <Arrow className="size-3 shrink-0" /> : null}
      </button>
    );
  };

  return (
    <div
      ref={box.ref}
      className="relative min-h-0 flex-1 overflow-auto"
      onScroll={box.onScroll}
      data-testid="file-table"
    >
      <div
        style={{ gridTemplateColumns: columns.template, height: HEADER_HEIGHT }}
        className="group/head sticky top-0 z-10 grid items-center gap-x-3 border-b lw-divider bg-white/95 px-4 text-xs font-medium text-zinc-500 backdrop-blur dark:bg-zinc-950/95"
      >
        <input
          type="checkbox"
          aria-label="Select every matching file"
          title="Select every matching file  ⌘A"
          className={`lw-check ${choosing ? "" : "opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100"}`}
          checked={allSelected}
          onChange={(event) =>
            event.target.checked ? props.onSelectAll() : props.onSelect(new Set())
          }
        />
        {header("Name", "name")}
        {header("Format", "kind")}
        {columns.dimensions ? header("Dimensions", "duration") : null}
        <div className="flex h-full justify-end">{header("Size", "size", "right")}</div>
        {columns.modified ? (
          <div className="flex h-full justify-end">{header("Modified", "mtime", "right")}</div>
        ) : null}
      </div>

      <div style={{ height: (total ?? 0) * ROW_HEIGHT + bottomInset }} className="relative">
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
              style={{
                top: index * ROW_HEIGHT,
                height: ROW_HEIGHT,
                gridTemplateColumns: columns.template,
              }}
              onClick={(event) => cursorKeys.click(index, row, event)}
              onDoubleClick={() => props.onOpen(row)}
              onContextMenu={(event) => cursorKeys.contextMenu(index, row, event)}
              className={`group absolute inset-x-0 grid cursor-default items-center gap-x-3 border-b border-zinc-100 px-4 text-[13px] lw-focus select-none dark:border-white/[0.04] ${
                selected.has(row.id) ? "lw-selected" : "lw-hover"
              } ${index === cursor ? "shadow-[inset_2px_0_0_var(--color-zinc-400)] dark:shadow-[inset_2px_0_0_var(--color-zinc-500)]" : ""}`}
            >
              <input
                type="checkbox"
                aria-label={`Select ${row.name}`}
                className={`lw-check ${choosing ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
                checked={selected.has(row.id)}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => cursorKeys.toggle(index, row, event.target.checked)}
              />
              <span className="flex min-w-0 items-center gap-3">
                <Thumbnail row={row} size={32} />
                <span className="min-w-0 flex-1">
                  {renaming === row.id ? (
                    <RenameField
                      row={row}
                      className="-my-0.5"
                      onDone={(name) => props.onRenameEnd(row, name)}
                    />
                  ) : (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-zinc-900 dark:text-zinc-100">{row.name}</span>
                      {isMuteVideo(row) && row.audioState ? (
                        <span
                          role="img"
                          title={AUDIO_LABELS[row.audioState]}
                          aria-label={AUDIO_LABELS[row.audioState]}
                          className="shrink-0 text-zinc-400 dark:text-zinc-500"
                        >
                          <VolumeX className="size-3.5" />
                        </span>
                      ) : null}
                    </span>
                  )}
                  <StartTruncate text={row.dir || props.rootName} className="lw-caption" />
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
                <span className="truncate">{formatLabel(row.format)}</span>
                {row.extensionMismatch ? (
                  <span
                    title={`The file is ${formatLabel(row.format)} but its extension is .${row.ext}`}
                    className="truncate text-amber-700 dark:text-amber-300"
                  >
                    .{row.ext}
                  </span>
                ) : null}
              </span>
              {columns.dimensions ? (
                <span className="truncate text-zinc-500 dark:text-zinc-400">
                  {dimensionsOf(row)}
                </span>
              ) : null}
              <span className="text-right text-zinc-600 dark:text-zinc-300">
                {formatBytes(row.size)}
              </span>
              {columns.modified ? (
                <span className="truncate text-right text-zinc-500 dark:text-zinc-400">
                  {formatDate(row.mtimeMs)}
                </span>
              ) : null}
            </div>
          ) : (
            <div
              key={`pending-${index}`}
              style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
              className="absolute inset-x-0 flex items-center gap-3 px-4 pl-11"
            >
              <span className="size-8 rounded-md bg-zinc-100 dark:bg-white/[0.04]" />
              <span className="h-2.5 w-1/4 rounded-full bg-zinc-100 dark:bg-white/[0.04]" />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/** Pixels for pictures, the length for videos, and why a file shows nothing. */
function dimensionsOf(row: FileRow): string {
  if (row.probeError) {
    return "Won't open";
  }

  if (row.kind === "video" && row.durationMs !== null) {
    return formatDuration(row.durationMs);
  }

  return row.width !== null && row.height !== null ? `${row.width}×${row.height}` : "";
}
