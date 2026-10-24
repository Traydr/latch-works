import type { DuplicateSet, FileId, FileRow } from "@latch-works/glazier-core/contract";
import { Check, FolderOpen, Maximize2 } from "lucide-react";
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FolderPath } from "../../../../../ui/ui";
import { desktop, mediaUrl, thumbnailUrl } from "../../lib/api";
import { Thumbnail } from "../media";
import { VideoControls } from "../VideoControls";
import { factsOf, type SetRow } from "./model";

/** Up to six versions fit the stage without scrolling; more scroll at this tile height. */
const SCROLLING_TILE_HEIGHT = 300;

const GAP = 16;

/** Room under each picture for its folder (two lines) and facts, plus the tile's padding. */
const CAPTION_HEIGHT = 68;

/** Folders that hold more than one version, where only the file name tells them apart. */
function sharedFolders(rows: readonly SetRow[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();

  for (const { file } of rows) {
    if (seen.has(file.dir)) {
      shared.add(file.dir);
    }

    seen.add(file.dir);
  }

  return shared;
}

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
  // Two lines for a copy's folder, and one for the file name where two versions share a folder.
  const copiesRoom = rows.some((row) => row.copies.length > 0) ? 32 : 0;
  const nameRoom = sharedFolders(rows).size > 0 ? 16 : 0;

  const rowHeight =
    (box.height - GAP * (lines - 1)) / lines - CAPTION_HEIGHT - copiesRoom - nameRoom;

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
 * version keeps only it and moves on, as its number key does; its checkbox (or ⇧-click) keeps it
 * as well, so several versions can stay. The keeper carries the violet ring and Keep badge; a
 * close call's keeper is only "Suggested", with a fainter ring, since the app is not sure.
 */
export function VersionGrid({
  set,
  rows,
  kept,
  keepReason,
  closeCall,
  focus,
  showFocus,
  readOnly,
  onHover,
  onLook,
  onKeepOnly,
  onToggleKeep,
}: {
  set: DuplicateSet;
  rows: readonly SetRow[];
  kept: ReadonlySet<FileId>;
  /** What decided the keeper, shown on its badge's tooltip. */
  keepReason: string | null;
  closeCall: boolean;
  focus: number;
  /** Whether the focus is drawn: only once the arrow keys are used, so nothing looks picked. */
  showFocus: boolean;
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
  const shared = sharedFolders(rows);
  // One video plays at a time, so the one heard is the one that was started last.
  const [playingId, setPlayingId] = useState<FileId | null>(null);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: leaving the grid only clears which version the pointer is on.
    <div
      ref={box}
      onMouseLeave={() => onHover(null)}
      className={`min-h-0 flex-1 px-5 pt-4 pb-[76px] ${scrolls ? "overflow-y-auto" : "overflow-hidden"}`}
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
              keepReason={keepReason}
              showName={shared.has(row.file.dir)}
              suggested={closeCall && kept.has(row.file.id)}
              canUnkeep={several && kept.has(row.file.id)}
              focused={showFocus && index === focus}
              hardLinked={linked.has(row.file.id)}
              well={well}
              playing={playingId === row.file.id}
              onPlayed={() => setPlayingId(row.file.id)}
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
  keepReason,
  showName,
  suggested,
  canUnkeep,
  focused,
  hardLinked,
  well,
  playing,
  onPlayed,
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
  keepReason: string | null;
  /** The file name, for a version that shares its folder with another. */
  showName: boolean;
  /** The keeper of a close call: shown as a suggestion, not a verdict. */
  suggested: boolean;
  canUnkeep: boolean;
  focused: boolean;
  hardLinked: boolean;
  /** The picture well's height in pixels, or null to fill a fixed-height tile. */
  well: number | null;
  /** Whether this tile's video is the one playing; another starting pauses it. */
  playing: boolean;
  onPlayed: () => void;
  readOnly: boolean;
  onHover: () => void;
  onLook: () => void;
  onKeepOnly: () => void;
  onToggleKeep: () => void;
}) {
  const { file } = row;
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const facts = factsOf(file, keeper);
  const [copy] = row.copies;
  const playable = file.kind === "video" && canShow(file);

  useEffect(() => {
    if (!playing && video && !video.paused) {
      video.pause();
    }
  }, [playing, video]);

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

  const revealed = focused ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100";

  return (
    // biome-ignore lint/a11y: the review's number keys pick versions from the keyboard; a click on the picture is the mouse's way to the same.
    <div
      data-file-name={file.name}
      data-keep={isKept}
      data-version={number}
      title={
        readOnly
          ? file.relPath
          : `${file.relPath}\nClick to keep only this one and go on  ${number}`
      }
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
          // biome-ignore lint/a11y/useMediaCaption: archive videos carry no caption tracks; their sound is what is being checked.
          <video
            ref={setVideo}
            src={mediaUrl(file.absPath)}
            poster={thumbnailUrl(file.absPath, 768)}
            playsInline
            preload="metadata"
            onPlay={onPlayed}
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

        {/*
          The checkbox keeps this version alongside the others (several can be kept, as for
          alternates that only look alike); the number teaches the click: "4 · Click to keep".
        */}
        <span className="absolute top-2 left-2 flex items-center gap-1.5">
          {readOnly ? null : (
            // biome-ignore lint/a11y: the checkbox inside takes the keyboard; the label only keeps its click from keeping this version alone.
            <label
              className="flex size-6 cursor-pointer items-center justify-center rounded-md bg-white/90 shadow-[0_1px_2px_rgb(0_0_0/0.3)] dark:bg-zinc-900/80"
              title={
                !isKept
                  ? `Keep this one as well  ⇧${number}`
                  : canUnkeep
                    ? `Don't keep this one  ⇧${number}`
                    : "Kept. Check another to keep more than one"
              }
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.preventDefault()}
            >
              <input
                type="checkbox"
                className="gz-check"
                tabIndex={-1}
                checked={isKept}
                aria-label={`Keep version ${number}`}
                onClick={(event) => event.stopPropagation()}
                onChange={onToggleKeep}
              />
            </label>
          )}
          <span
            className={`gz-badge min-w-6 justify-center ${
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
        </span>

        <span className="absolute top-2 right-2 flex items-center gap-1.5">
          <button
            type="button"
            title="Show in Finder  ⇧⌘R"
            aria-label="Show in Finder"
            onClick={(event) => {
              event.stopPropagation();
              void desktop.reveal(file.absPath);
            }}
            className={`gz-btn gz-btn-icon-sm bg-white text-zinc-900 shadow-[0_2px_8px_rgb(0_0_0/0.3)] hover:bg-zinc-100 ${revealed}`}
          >
            <FolderOpen />
          </button>
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
              <span
                className="gz-badge bg-white/90 text-zinc-900 dark:bg-black/60 dark:text-white"
                title={keepReason ?? undefined}
              >
                Suggested
              </span>
            ) : (
              <span className="gz-badge gz-badge-keep" title={keepReason ?? undefined}>
                <Check className="size-3.5" /> Keep
              </span>
            )
          ) : null}
        </span>

        {/* Each video plays with its sound, to check its length and soundtrack against the rest. */}
        {playable ? (
          <VideoControls
            video={video}
            shown={focused}
            className="absolute right-2 bottom-2 left-2"
          />
        ) : null}
      </div>

      <div className="px-2 pt-2 pb-1.5">
        <FolderPath dir={file.dir} lines={2} className="text-[13px] leading-[18px]" />
        {showName ? <p className="gz-caption truncate">{file.name}</p> : null}
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
        {/* A byte-identical copy elsewhere goes with this version, so its folder shows too. */}
        {row.copies.length > 1 ? (
          <p
            className="gz-caption truncate"
            title={row.copies.map((other) => other.relPath).join("\n")}
          >
            Also in {row.copies.length} other folders
          </p>
        ) : copy ? (
          <FolderPath dir={copy.dir} lines={2} lead="Also in" className="gz-caption" />
        ) : null}
        {hardLinked ? (
          <p className="gz-caption truncate">A hard link, so it frees nothing</p>
        ) : null}
      </div>
    </div>
  );
}
