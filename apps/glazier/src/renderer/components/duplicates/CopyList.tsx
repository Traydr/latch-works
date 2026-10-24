import type { FileId, FileRow } from "@latch-works/glazier-core/contract";
import { FolderOpen } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { desktop, mediaUrl, thumbnailUrl } from "../../lib/api";
import {
  formatBytes,
  formatDateTime,
  formatDateTimeSeconds,
  formatLabel,
  plural,
} from "../../lib/format";
import { describeDetails, Thumbnail } from "../media";
import { FolderPath } from "../ui";
import { VideoControls } from "../VideoControls";
import type { SetRow } from "./model";

/** Below this stage width the list goes under the picture, so folder names stay readable. */
const STACK_BELOW = 680;

function canShow(file: FileRow): boolean {
  return (file.kind === "image" || file.kind === "video") && file.probeError === null;
}

/**
 * Byte-identical copies: there is nothing to compare, so the picture shows once (a video plays,
 * with its sound) and the choice is where the file stays. Clicking a place (or pressing its
 * number) keeps the copy there and moves on; checking several (or ⇧-clicking) keeps the copy in
 * each, for when one file belongs in more than one folder. Each place leads with what tells them
 * apart, its whole folder path, then the date (the oldest copy is the usual pick), and opens in
 * Finder from its folder button.
 */
export function CopyList({
  rows,
  kept,
  keepReason,
  focus,
  showFocus,
  readOnly,
  onHover,
  onKeepOnly,
  onToggleKeep,
}: {
  rows: readonly SetRow[];
  kept: ReadonlySet<FileId>;
  /** What decided the keeper, shown on its badge's tooltip. */
  keepReason: string | null;
  focus: number;
  showFocus: boolean;
  readOnly: boolean;
  /** The place under the pointer, or null once it leaves the list. */
  onHover: (index: number | null) => void;
  onKeepOnly: (index: number) => void;
  onToggleKeep: (index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);

  useLayoutEffect(() => {
    const element = box.current;

    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => setStacked(element.clientWidth < STACK_BELOW));

    observer.observe(element);
    setStacked(element.clientWidth < STACK_BELOW);

    return () => observer.disconnect();
  }, []);

  const first = rows[0]?.file;

  if (!first) {
    return <div ref={box} className="flex-1" />;
  }

  const sameName = rows.every((row) => row.file.name === first.name);

  // When two copies share a minute, "the oldest" needs the seconds to be seen to be true.
  const minutes = rows.map((row) => formatDateTime(row.file.mtimeMs));
  const dateOf = new Set(minutes).size < minutes.length ? formatDateTimeSeconds : formatDateTime;
  const aspect = first.width && first.height ? `${first.width} / ${first.height}` : "4 / 3";

  return (
    <div
      ref={box}
      className={`flex min-h-0 flex-1 gap-6 overflow-y-auto px-5 pt-4 pb-[76px] ${
        stacked ? "flex-col" : "items-start"
      }`}
    >
      <div
        className={`gz-well flex shrink-0 items-center justify-center overflow-hidden ${
          stacked ? "max-h-[40%] w-full" : "max-h-full flex-1"
        }`}
        style={{ aspectRatio: aspect }}
      >
        {!canShow(first) ? (
          <Thumbnail row={first} size={72} />
        ) : first.kind === "video" ? (
          <div className="group relative flex max-h-full max-w-full items-center justify-center">
            {/* biome-ignore lint/a11y/useMediaCaption: archive videos carry no caption tracks; their sound is what is being checked. */}
            <video
              key={first.id}
              ref={setVideo}
              src={mediaUrl(first.absPath)}
              poster={thumbnailUrl(first.absPath, 1024)}
              playsInline
              preload="metadata"
              className="gz-media-edge max-h-full max-w-full object-contain"
            />
            <VideoControls video={video} className="absolute right-2 bottom-2 left-2" />
          </div>
        ) : (
          <img
            src={thumbnailUrl(first.absPath, 1024)}
            alt=""
            draggable={false}
            className="gz-media-edge max-h-full max-w-full object-contain"
          />
        )}
      </div>

      <div className={`flex min-w-0 flex-col ${stacked ? "w-full" : "flex-1"}`}>
        <h2 className="gz-heading">{plural(rows.length, "identical copy", "identical copies")}</h2>
        <p className="gz-caption mt-1">
          {[
            sameName ? first.name : null,
            formatLabel(first.format),
            describeDetails(first),
            `${formatBytes(first.size)} each`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        <div className="mt-5 mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-xs font-medium whitespace-nowrap text-zinc-500">Keep the copy in</p>
          {readOnly ? null : (
            <p className="gz-caption whitespace-nowrap">Check more than one to keep several</p>
          )}
        </div>
        <ul
          className="gz-card divide-y gz-divider overflow-hidden"
          onMouseLeave={() => onHover(null)}
        >
          {rows.map((row, index) => {
            const isKept = kept.has(row.file.id);
            const where = row.file.dir || "the top folder";

            return (
              <li
                key={row.file.id}
                onMouseEnter={() => onHover(index)}
                className={`gz-hover group flex items-center pr-2 ${
                  showFocus && index === focus ? "shadow-[inset_0_0_0_1px_rgb(161_161_170)]" : ""
                }`}
              >
                {/* Checking several keeps the copy in each; Return (or Keep) applies them. */}
                <label
                  className="flex shrink-0 cursor-pointer items-center self-stretch pr-1 pl-3"
                  title={
                    isKept
                      ? (keepReason ?? `Keeping the copy in ${where}`)
                      : `Keep the copy in ${where} as well  ⇧${index + 1}`
                  }
                >
                  <input
                    type="checkbox"
                    className="gz-check"
                    tabIndex={-1}
                    checked={isKept}
                    disabled={readOnly}
                    aria-label={`Keep the copy in ${where}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onChange={() => onToggleKeep(index)}
                  />
                </label>
                <button
                  type="button"
                  disabled={readOnly}
                  data-file-name={row.file.name}
                  data-keep={isKept}
                  title={`${row.file.relPath}\nClick to keep only this copy and go on  ${index + 1}`}
                  onClick={(event) => {
                    // A double-click's second click must not decide the next set.
                    if (event.detail > 1) {
                      return;
                    }

                    if (event.shiftKey) {
                      onToggleKeep(index);
                    } else {
                      onKeepOnly(index);
                    }
                  }}
                  className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left outline-none disabled:pointer-events-none"
                >
                  <span className="gz-kbd shrink-0">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <FolderPath
                      dir={row.file.dir}
                      lines={3}
                      className="text-[13px] leading-[18px]"
                    />
                    <span className="gz-caption block truncate">
                      {dateOf(row.file.mtimeMs)}
                      {sameName ? null : ` · ${row.file.name}`}
                    </span>
                  </span>
                  {isKept || readOnly ? null : (
                    <span className="gz-caption shrink-0 opacity-0 group-hover:opacity-100">
                      Keep only this
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="gz-btn gz-btn-ghost gz-btn-icon-sm shrink-0"
                  title="Show in Finder  ⇧⌘R"
                  aria-label={`Show the copy in ${where} in Finder`}
                  onClick={() => void desktop.reveal(row.file.absPath)}
                >
                  <FolderOpen />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
