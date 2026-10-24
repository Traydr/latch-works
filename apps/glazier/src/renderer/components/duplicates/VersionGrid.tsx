import type { DuplicateSet, FileId, FileRow } from "@latch-works/glazier-core/contract";
import { Check, Maximize2, Minus, Plus } from "lucide-react";
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { mediaUrl, thumbnailUrl } from "../../lib/api";
import { Thumbnail } from "../media";
import { StartTruncate } from "../ui";
import { copiesLine, factsOf, type SetRow } from "./model";

/** Up to six versions fit the stage without scrolling; more scroll at this tile height. */
const SCROLLING_TILE_HEIGHT = 300;

const GAP = 16;

/** Room under each picture for its name, folder and facts, plus the tile's padding. */
const CAPTION_HEIGHT = 76;

interface Box {
  width: number;
  height: number;
}

function aspectOf(rows: readonly SetRow[]): number {
  const file = rows[0]?.file;

  return file?.width && file.height ? file.width / file.height : 4 / 3;
}

/** The picture well's height at a column count: as tall as the shape allows, within the stage. */
function wellHeight(rows: readonly SetRow[], box: Box, columns: number): number {
  const lines = Math.ceil(rows.length / columns);
  const columnWidth = (box.width - GAP * (columns - 1)) / columns - 8;
  const extra = rows.some((row) => row.copies.length > 0) ? 16 : 0;
  const rowHeight = (box.height - GAP * (lines - 1)) / lines - CAPTION_HEIGHT - extra;

  return Math.floor(Math.min(columnWidth / aspectOf(rows), rowHeight));
}

/** A pair goes side by side, as people compare two pictures, once each column has this room. */
const PAIR_COLUMN_MIN = 280;

/**
 * How many tiles across: the count that draws the pictures largest, as Lightroom's Survey fits
 * candidates by area, leaning to more columns when they lose under 15%. Wide 3:2 pictures on a
 * 16:10 screen go 2×2 rather than four across, and a pair sits side by side.
 */
function bestColumns(rows: readonly SetRow[], box: Box): number {
  if (rows.length === 2 && (box.width - GAP) / 2 >= PAIR_COLUMN_MIN) {
    return 2;
  }

  // A last row less than half full (four versions as 3 + 1) reads as a gap, so it is not tried.
  const even = (columns: number) => {
    const empty = Math.ceil(rows.length / columns) * columns - rows.length;

    return empty === 0 || empty < columns / 2;
  };

  const candidates = Array.from({ length: Math.min(rows.length, 4) }, (_, index) => index + 1)
    .reverse()
    .filter(even);

  let best = candidates[0] ?? 1;
  let bestHeight = wellHeight(rows, box, best);

  // From the most columns down, a layout with fewer has to be clearly (15%) larger to win.
  for (const columns of candidates.slice(1)) {
    const height = wellHeight(rows, box, columns);

    if (height > bestHeight * 1.15) {
      best = columns;
      bestHeight = height;
    }
  }

  return best;
}

function canShow(file: FileRow): boolean {
  return (file.kind === "image" || file.kind === "video") && file.probeError === null;
}

/**
 * Every version of a similar set at once, as Lightroom's Survey shows candidates. A click on a
 * version keeps only it and moves on, as its number key does; ⇧-click (or its +) keeps it as
 * well. The keeper carries the violet ring and Keep badge; a close call's keeper is only
 * "Suggested", with a dashed ring, since the app is not sure.
 */
export function VersionGrid({
  set,
  rows,
  kept,
  closeCall,
  focus,
  showFocus,
  playing,
  soundOn,
  readOnly,
  onHover,
  onLook,
  onKeepOnly,
  onToggleKeep,
}: {
  set: DuplicateSet;
  rows: readonly SetRow[];
  kept: ReadonlySet<FileId>;
  closeCall: boolean;
  focus: number;
  /** Whether the focus is drawn: only once the arrow keys are used, so nothing looks picked. */
  showFocus: boolean;
  playing: boolean;
  /** Only the focused tile is ever heard. */
  soundOn: boolean;
  readOnly: boolean;
  /** The version under the pointer, or null once it leaves the grid. */
  onHover: (index: number | null) => void;
  /** Opens the loupe on a version. */
  onLook: (index: number) => void;
  onKeepOnly: (index: number) => void;
  onToggleKeep: (index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Box>({ width: 900, height: 600 });

  useLayoutEffect(() => {
    const element = box.current;

    if (!element) {
      return;
    }

    // The content box: the stage less its padding, which leaves room for the decision bar.
    const measure = () => {
      const style = getComputedStyle(element);

      setSize({
        width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height:
          element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      });
    };

    const observer = new ResizeObserver(measure);

    observer.observe(element);
    measure();

    return () => observer.disconnect();
  }, []);

  const scrolls = rows.length > 6;
  const columns = scrolls ? (size.width >= 1400 ? 4 : 3) : bestColumns(rows, size);
  const lines = Math.ceil(rows.length / columns);
  const well = scrolls ? null : Math.max(120, wellHeight(rows, size, columns));

  // Each card hugs its picture, so no well carries side bars and the badges sit on its corners.
  const cardWidth = well === null ? null : Math.round(well * aspectOf(rows)) + 8;
  const keeper = rows.find((row) => kept.has(row.file.id))?.file ?? rows[0]?.file;
  const linked = new Set(set.hardLinkedIds);
  const several = kept.size > 1;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: leaving the grid only clears which version the pointer is on.
    <div
      ref={box}
      onMouseLeave={() => onHover(null)}
      className={`min-h-0 flex-1 px-5 pt-1 pb-[76px] ${scrolls ? "overflow-y-auto" : "overflow-hidden"}`}
    >
      <div
        className={`grid content-start gap-4 ${scrolls ? "" : "h-full"}`}
        style={{
          gridTemplateColumns:
            cardWidth === null
              ? `repeat(${columns}, minmax(0, 1fr))`
              : `repeat(${columns}, minmax(0, ${cardWidth}px))`,
          gridTemplateRows: scrolls ? `repeat(${lines}, ${SCROLLING_TILE_HEIGHT}px)` : undefined,
          justifyContent: "center",
        }}
      >
        {rows.map((row, index) =>
          keeper ? (
            <VersionTile
              key={row.file.id}
              row={row}
              number={index + 1}
              keeper={keeper}
              isKept={kept.has(row.file.id)}
              suggested={closeCall && kept.has(row.file.id)}
              canUnkeep={several && kept.has(row.file.id)}
              focused={showFocus && index === focus}
              hardLinked={linked.has(row.file.id)}
              well={well}
              playing={playing}
              heard={soundOn && index === focus}
              readOnly={readOnly}
              onHover={() => onHover(index)}
              onLook={() => onLook(index)}
              onKeepOnly={() => onKeepOnly(index)}
              onToggleKeep={() => onToggleKeep(index)}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function VersionTile({
  row,
  number,
  keeper,
  isKept,
  suggested,
  canUnkeep,
  focused,
  hardLinked,
  well,
  playing,
  heard,
  readOnly,
  onHover,
  onLook,
  onKeepOnly,
  onToggleKeep,
}: {
  row: SetRow;
  number: number;
  keeper: FileRow;
  isKept: boolean;
  /** The keeper of a close call: shown as a suggestion, not a verdict. */
  suggested: boolean;
  canUnkeep: boolean;
  focused: boolean;
  hardLinked: boolean;
  /** The picture well's height in pixels, or null to fill a fixed-height tile. */
  well: number | null;
  playing: boolean;
  heard: boolean;
  readOnly: boolean;
  onHover: () => void;
  onLook: () => void;
  onKeepOnly: () => void;
  onToggleKeep: () => void;
}) {
  const { file } = row;
  const video = useRef<HTMLVideoElement>(null);
  const facts = factsOf(file, keeper);
  const copies = copiesLine(row);

  useEffect(() => {
    const element = video.current;

    if (!element) {
      return;
    }

    if (playing) {
      element.currentTime = 0;
      void element.play().catch(() => undefined);
    } else {
      element.pause();
    }
  }, [playing]);

  const onClick = (event: MouseEvent) => {
    // A double-click's second click must not decide the next set, which is now under the pointer.
    if (readOnly || event.detail > 1) {
      return;
    }

    if (event.shiftKey) {
      onToggleKeep();
    } else {
      onKeepOnly();
    }
  };

  // One ring shape for every keeper; a close call's is fainter, since the app is not sure.
  const ring = isKept
    ? `ring-2 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950 ${
        suggested ? "ring-violet-500/45" : "ring-violet-500"
      }`
    : "";

  const extra = canUnkeep
    ? { icon: <Minus />, label: "Don't keep", title: `Don't keep this one  ⇧${number}` }
    : isKept
      ? null
      : { icon: <Plus />, label: "Keep as well", title: `Keep this one as well  ⇧${number}` };

  const revealed = focused ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100";

  return (
    // biome-ignore lint/a11y: the review's number keys pick versions from the keyboard; a click on the picture is the mouse's way to the same.
    <div
      data-file-name={file.name}
      data-keep={isKept}
      data-version={number}
      title={readOnly ? undefined : `Click to keep only this one and go on  ${number}`}
      onMouseEnter={onHover}
      onClick={onClick}
      className={`gz-card group relative flex min-h-0 min-w-0 flex-col p-1 ${
        readOnly ? "cursor-default" : "cursor-pointer"
      } ${focused || isKept ? "" : "hover:shadow-[var(--shadow-border-hover)]"} ${
        focused
          ? "shadow-[inset_0_0_0_1px_rgb(161_161_170)] dark:shadow-[inset_0_0_0_1px_rgb(113_113_122)]"
          : ""
      } ${ring}`}
    >
      <div
        className="gz-well relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg"
        style={well === null ? undefined : { height: well, flex: "none" }}
      >
        {!canShow(file) ? (
          <Thumbnail row={file} size={64} />
        ) : file.kind === "video" ? (
          <video
            ref={video}
            src={mediaUrl(file.absPath)}
            poster={thumbnailUrl(file.absPath, 768)}
            muted={!heard}
            loop
            playsInline
            preload="metadata"
            className="gz-media-edge max-h-full max-w-full object-contain"
          />
        ) : (
          <img
            src={thumbnailUrl(file.absPath, 768)}
            alt=""
            draggable={false}
            className="gz-media-edge max-h-full max-w-full object-contain"
          />
        )}

        {/* The number teaches the click on hover: "4 · Click to keep". */}
        <span
          className={`gz-badge absolute top-2 left-2 min-w-6 justify-center ${
            focused
              ? "bg-white text-zinc-900 shadow-[0_1px_2px_rgb(0_0_0/0.3)]"
              : "gz-badge-overlay"
          }`}
        >
          {number}
          {readOnly || isKept ? null : (
            <span className={focused ? "inline" : "hidden group-hover:inline"}>
              {" · Click to keep"}
            </span>
          )}
        </span>

        <span className="absolute top-2 right-2 flex items-center gap-1.5">
          <button
            type="button"
            title="Look closer  Space"
            aria-label="Look closer"
            onClick={(event) => {
              event.stopPropagation();
              onLook();
            }}
            className={`gz-btn gz-btn-icon-sm bg-white text-zinc-900 shadow-[0_2px_8px_rgb(0_0_0/0.3)] hover:bg-zinc-100 ${revealed}`}
          >
            <Maximize2 />
          </button>
          {isKept ? (
            suggested ? (
              <span className="gz-badge bg-white/90 text-zinc-900 dark:bg-black/60 dark:text-white">
                Suggested
              </span>
            ) : (
              <span className="gz-badge gz-badge-keep">
                <Check className="size-3.5" /> Keep
              </span>
            )
          ) : null}
        </span>

        {/* Keeping another as well sits a tile's width from the click that keeps only this. */}
        {readOnly || !extra ? null : (
          <button
            type="button"
            title={extra.title}
            onClick={(event) => {
              event.stopPropagation();
              onToggleKeep();
            }}
            className={`gz-btn gz-btn-sm absolute right-2 bottom-2 bg-white text-zinc-900 shadow-[0_2px_8px_rgb(0_0_0/0.3)] hover:bg-zinc-100 ${revealed}`}
          >
            {extra.icon}
            {extra.label}
          </button>
        )}
      </div>

      <div className="px-2 pt-2 pb-1.5">
        <p className="truncate text-[13px] font-medium" title={file.relPath}>
          {file.name}
        </p>
        <StartTruncate text={file.dir || "Top folder"} className="gz-caption" />
        <p className="gz-caption truncate">
          {facts.map((fact, index) => (
            <span key={fact.text}>
              {index > 0 ? " · " : ""}
              <span className={fact.worse ? "font-medium text-amber-700 dark:text-amber-300" : ""}>
                {fact.text}
              </span>
            </span>
          ))}
        </p>
        {copies || hardLinked ? (
          <p className="gz-caption truncate">
            {[copies, hardLinked ? "A hard link, so it frees nothing" : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
