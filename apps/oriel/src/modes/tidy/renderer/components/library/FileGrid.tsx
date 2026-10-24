import type { FileRow } from "@latch-works/glazier-core/contract";
import { useEffect, useMemo } from "react";

import { formatBytes } from "../../lib/format";
import { Thumbnail } from "../media";
import { RenameField } from "./RenameField";
import { type FileViewProps, useFileCursor, visibleRange } from "./use-file-cursor";
import { useScrollBox } from "./use-scroll-box";

const MIN_TILE = 180;

const GAP = 12;

const PAD_X = 20;

const PAD_TOP = 16;

/** The tile's padding (4 px each side) and the two 16 px lines under the picture. */
const TILE_CHROME = 8 + 44;

/**
 * Frame View's tiles: square pictures about 180 px wide, the name and size under each. Only the
 * lines in view are drawn, so an archive of 40,000 files scrolls as fast as one of 40.
 */
export function FileGrid(props: FileViewProps) {
  const { pages, selected, cursor, renaming, bottomInset } = props;
  const box = useScrollBox();
  const { total, rowAt, request } = pages;
  const inner = Math.max(MIN_TILE, box.width - PAD_X * 2);
  const columns = Math.max(1, Math.floor((inner + GAP) / (MIN_TILE + GAP)));
  const tile = (inner - GAP * (columns - 1)) / columns;
  const tileHeight = tile - 8 + TILE_CHROME;
  const line = tileHeight + GAP;
  const lines = Math.ceil((total ?? 0) / columns);

  const { first, last } = visibleRange(
    Math.max(0, box.scrollTop - PAD_TOP),
    box.height,
    line,
    columns,
    total,
  );

  useEffect(() => request(first, last), [first, last, request]);

  const cursorKeys = useFileCursor({
    ...props,
    columns,
    reveal: (index) => {
      const top = PAD_TOP + Math.floor(index / columns) * line;

      box.show(top, top + tileHeight, PAD_TOP, bottomInset);
    },
  });

  const visible = useMemo(() => {
    const tiles: Array<{ index: number; row: FileRow | null }> = [];

    for (let index = first; index < Math.min(last, total ?? 0); index += 1) {
      tiles.push({ index, row: rowAt(index) });
    }

    return tiles;
  }, [first, last, rowAt, total]);

  const choosing = selected.size > 0;

  return (
    <div
      ref={box.ref}
      className="relative min-h-0 flex-1 overflow-auto"
      onScroll={box.onScroll}
      data-testid="file-grid"
    >
      <div style={{ height: PAD_TOP + lines * line + bottomInset }} className="relative">
        {visible.map(({ index, row }) => {
          const position = {
            top: PAD_TOP + Math.floor(index / columns) * line,
            left: PAD_X + (index % columns) * (tile + GAP),
            width: tile,
            height: tileHeight,
          };

          if (!row) {
            return (
              <div
                key={`pending-${index}`}
                style={position}
                className="absolute rounded-xl bg-zinc-100 dark:bg-white/[0.04]"
              />
            );
          }

          const isSelected = selected.has(row.id);

          return (
            // biome-ignore lint/a11y: virtualized tiles sit absolutely positioned; the grid handles keys for every tile (useViewKeys).
            <div
              key={row.id}
              role="row"
              tabIndex={-1}
              aria-selected={isSelected}
              data-file-name={row.name}
              data-selected={isSelected}
              style={position}
              onClick={(event) => cursorKeys.click(index, row, event)}
              onDoubleClick={() => props.onOpen(row)}
              onContextMenu={(event) => cursorKeys.contextMenu(index, row, event)}
              className={`group lw-card absolute cursor-default p-1 lw-focus select-none ${
                index === cursor
                  ? "ring-2 ring-violet-500"
                  : isSelected
                    ? "ring-2 ring-zinc-900/25 dark:ring-white/30"
                    : ""
              } ${isSelected ? "lw-selected" : ""}`}
            >
              <div className="relative">
                <Thumbnail row={row} fill className="rounded-lg" />
                <input
                  type="checkbox"
                  aria-label={`Select ${row.name}`}
                  className={`lw-check absolute top-2 left-2 drop-shadow-[0_1px_2px_rgb(0_0_0/0.4)] ${
                    choosing ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  }`}
                  checked={isSelected}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => cursorKeys.toggle(index, row, event.target.checked)}
                />
              </div>
              <div className="px-1.5 pt-1.5 pb-1.5 text-xs leading-4">
                {renaming === row.id ? (
                  <RenameField
                    row={row}
                    className="h-4 text-xs"
                    onDone={(name) => props.onRenameEnd(row, name)}
                  />
                ) : (
                  <p className="truncate font-medium text-zinc-800 dark:text-zinc-100">
                    {row.name}
                  </p>
                )}
                <p className="truncate text-zinc-500 dark:text-zinc-400">{formatBytes(row.size)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
