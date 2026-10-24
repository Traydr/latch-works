import type { FileId, FileRow } from "@latch-works/glazier-core/contract";
import { Check } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { thumbnailUrl } from "../../lib/api";
import {
  formatBytes,
  formatDateTime,
  formatDateTimeSeconds,
  formatLabel,
  plural,
} from "../../lib/format";
import { describeDetails, Thumbnail } from "../media";
import { StartTruncate } from "../ui";
import type { SetRow } from "./model";

/** Below this stage width the list goes under the picture, so folder names stay readable. */
const STACK_BELOW = 680;

function canShow(file: FileRow): boolean {
  return (file.kind === "image" || file.kind === "video") && file.probeError === null;
}

/** Where a copy sits: its last folder, said in full, and the path above it. */
interface Place {
  folder: string;
  parent: string | null;
}

function placeOf(file: FileRow): Place {
  if (!file.dir) {
    return { folder: "Top folder", parent: null };
  }

  const segments = file.dir.split("/");

  return {
    folder: segments.at(-1) ?? file.dir,
    parent: segments.length > 1 ? segments.slice(0, -1).join("/") : null,
  };
}

/**
 * Byte-identical copies: there is nothing to compare, so the picture shows once and the choice is
 * where the file stays. Clicking a place (or pressing its number) keeps the copy there and moves
 * on; ⇧-click keeps it as well. Each place leads with what tells them apart: its folder, then
 * the date (the oldest copy is the usual pick).
 */
export function CopyList({
  rows,
  kept,
  focus,
  showFocus,
  readOnly,
  onHover,
  onKeepOnly,
  onToggleKeep,
}: {
  rows: readonly SetRow[];
  kept: ReadonlySet<FileId>;
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
      className={`flex min-h-0 flex-1 gap-6 overflow-y-auto px-5 pt-1 pb-[76px] ${
        stacked ? "flex-col" : "items-start"
      }`}
    >
      <div
        className={`gz-well flex shrink-0 items-center justify-center overflow-hidden ${
          stacked ? "max-h-[40%] w-full" : "max-h-full flex-[3]"
        }`}
        style={{ aspectRatio: aspect }}
      >
        {canShow(first) ? (
          <img
            src={thumbnailUrl(first.absPath, 1024)}
            alt=""
            draggable={false}
            className="gz-media-edge max-h-full max-w-full object-contain"
          />
        ) : (
          <Thumbnail row={first} size={72} />
        )}
      </div>

      <div className={`flex min-w-0 flex-col ${stacked ? "w-full" : "flex-[2]"}`}>
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

        <p className="mt-5 mb-2 text-xs font-medium text-zinc-500">Keep the copy in</p>
        <ul
          className="gz-card divide-y gz-divider overflow-hidden"
          onMouseLeave={() => onHover(null)}
        >
          {rows.map((row, index) => {
            const isKept = kept.has(row.file.id);
            const place = placeOf(row.file);

            return (
              <li key={row.file.id}>
                <button
                  type="button"
                  disabled={readOnly}
                  data-file-name={row.file.name}
                  data-keep={isKept}
                  title={`${row.file.relPath}\nClick to keep this copy and go on  ${index + 1}  ·  ⇧-click keeps it as well`}
                  onMouseEnter={() => onHover(index)}
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
                  className={`gz-hover group flex h-[52px] w-full items-center gap-3 px-3 text-left outline-none disabled:pointer-events-none ${
                    showFocus && index === focus ? "shadow-[inset_0_0_0_1px_rgb(161_161_170)]" : ""
                  }`}
                >
                  <span className="gz-kbd shrink-0">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{place.folder}</span>
                    <span className="gz-caption flex min-w-0 gap-1">
                      <span className="shrink-0">{dateOf(row.file.mtimeMs)}</span>
                      {place.parent ? (
                        <>
                          <span className="shrink-0">·</span>
                          <StartTruncate text={place.parent} className="min-w-0" />
                        </>
                      ) : null}
                      {sameName ? null : (
                        <>
                          <span className="shrink-0">·</span>
                          <span className="truncate">{row.file.name}</span>
                        </>
                      )}
                    </span>
                  </span>
                  {isKept ? (
                    <span className="gz-badge gz-badge-keep shrink-0">
                      <Check className="size-3.5" /> Keep
                    </span>
                  ) : readOnly ? null : (
                    <span className="gz-caption shrink-0 opacity-0 group-hover:opacity-100">
                      Click to keep
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
