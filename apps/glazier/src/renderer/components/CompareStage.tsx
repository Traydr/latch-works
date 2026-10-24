import type { FileFormat, FileRow } from "@latch-works/glazier-core/contract";
import { Star } from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";

import { mediaUrl, thumbnailUrl } from "../lib/api";
import { Thumbnail } from "./media";

/** Formats Chromium draws itself, so 100% shows the file's own pixels. */
const BROWSER_FORMATS = new Set<FileFormat>(["jpeg", "png", "gif", "webp", "avif", "bmp", "svg"]);

interface Pane {
  row: FileRow;
  /** 1-based, as the number keys and the version table count. */
  number: number;
  kept: boolean;
}

function canShow(row: FileRow): boolean {
  return (row.kind === "image" || row.kind === "video") && row.probeError === null;
}

/**
 * The kept version beside the one in focus. At 100% both draw at the larger one's width, so the
 * same region shows at the same scale, and scrolling one pane scrolls the other.
 */
export function CompareStage({
  left,
  right,
  zoomed,
  playing,
  muted,
}: {
  left: Pane;
  right: Pane | null;
  zoomed: boolean;
  playing: boolean;
  /** Only the kept version is heard when sound is on, so two tracks never play over each other. */
  muted: boolean;
}) {
  const leftBox = useRef<HTMLDivElement>(null);
  const rightBox = useRef<HTMLDivElement>(null);
  const leftVideo = useRef<HTMLVideoElement>(null);
  const rightVideo = useRef<HTMLVideoElement>(null);
  const width = Math.max(left.row.width ?? 0, right?.row.width ?? 0) || undefined;

  useEffect(() => {
    const videos = [leftVideo.current, rightVideo.current].filter(
      (video): video is HTMLVideoElement => video !== null,
    );

    if (playing) {
      const start = videos[0]?.currentTime ?? 0;

      for (const video of videos) {
        video.currentTime = start;
        void video.play().catch(() => undefined);
      }
    } else {
      for (const video of videos) {
        video.pause();
      }
    }
  }, [playing]);

  const sync = (from: RefObject<HTMLDivElement | null>, to: RefObject<HTMLDivElement | null>) => {
    if (from.current && to.current) {
      to.current.scrollLeft = from.current.scrollLeft;
      to.current.scrollTop = from.current.scrollTop;
    }
  };

  return (
    <div className={`grid min-h-0 flex-1 gap-3 ${right ? "grid-cols-2" : "grid-cols-1"}`}>
      <StagePane
        pane={left}
        zoomed={zoomed}
        width={width}
        box={leftBox}
        video={leftVideo}
        muted={muted}
        onScroll={() => sync(leftBox, rightBox)}
      />
      {right ? (
        <StagePane
          pane={right}
          zoomed={zoomed}
          width={width}
          box={rightBox}
          video={rightVideo}
          muted
          onScroll={() => sync(rightBox, leftBox)}
        />
      ) : null}
    </div>
  );
}

function StagePane({
  pane,
  zoomed,
  width,
  box,
  video,
  muted,
  onScroll,
}: {
  pane: Pane;
  zoomed: boolean;
  width: number | undefined;
  box: RefObject<HTMLDivElement | null>;
  video: RefObject<HTMLVideoElement | null>;
  muted: boolean;
  onScroll: () => void;
}) {
  const { row } = pane;

  return (
    <figure className="flex min-h-0 min-w-0 flex-col gap-1.5" data-pane={pane.number}>
      <figcaption className="ls-mono flex items-center gap-1.5 text-[10.5px] text-zinc-500">
        <span className="font-semibold text-zinc-700 dark:text-zinc-200">{pane.number}</span>
        {pane.kept ? (
          <span className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-300">
            <Star className="size-3 fill-current" /> keep
          </span>
        ) : (
          <span>to holding</span>
        )}
        <span className="truncate">{row.relPath}</span>
      </figcaption>
      <div
        ref={box}
        onScroll={onScroll}
        className={`relative min-h-0 flex-1 rounded-md bg-zinc-100 dark:bg-zinc-900 ${
          zoomed ? "overflow-auto" : "flex items-center justify-center overflow-hidden"
        } ${pane.kept ? "ring-2 ring-violet-500/60" : ""}`}
      >
        {!canShow(row) ? (
          <div className="flex h-full items-center justify-center">
            <Thumbnail row={row} size={64} />
          </div>
        ) : row.kind === "video" ? (
          <video
            ref={video}
            src={mediaUrl(row.absPath)}
            poster={thumbnailUrl(row.absPath, 1024)}
            muted={muted}
            loop
            playsInline
            preload="metadata"
            style={zoomed && width ? { width, maxWidth: "none" } : undefined}
            className={zoomed ? "block" : "max-h-full max-w-full object-contain"}
          />
        ) : (
          <img
            src={
              zoomed && row.format !== null && BROWSER_FORMATS.has(row.format)
                ? mediaUrl(row.absPath)
                : thumbnailUrl(row.absPath, 1024)
            }
            alt=""
            draggable={false}
            style={zoomed && width ? { width, maxWidth: "none" } : undefined}
            className={zoomed ? "block" : "max-h-full max-w-full object-contain"}
          />
        )}
      </div>
    </figure>
  );
}
