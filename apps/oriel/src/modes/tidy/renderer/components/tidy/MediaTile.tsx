import type { FileRow } from "@latch-works/glazier-core/contract";
import { useState } from "react";

import { thumbnailUrl } from "../../lib/api";
import { formatBytes } from "../../lib/format";

/**
 * A picture of a file at any size, or its extension when there is nothing to show. `cover` fills
 * the box `className` sizes; `contain` keeps the picture's shape inside its parent, so the media
 * edge follows the picture rather than the box.
 */
export function Poster({
  row,
  size,
  className,
  fit = "cover",
}: {
  row: FileRow;
  size: number;
  className: string;
  fit?: "cover" | "contain";
}) {
  const [failed, setFailed] = useState(false);

  const showable =
    (row.kind === "image" || row.kind === "video") && row.probeError === null && !failed;

  if (!showable) {
    return (
      <span
        className={`flex items-center justify-center text-xs font-medium text-zinc-500 uppercase ${
          fit === "cover" ? "lw-media-edge bg-zinc-100 dark:bg-zinc-800" : "size-full"
        } ${className}`}
      >
        {row.ext.slice(0, 4)}
      </span>
    );
  }

  return (
    <img
      src={thumbnailUrl(row.absPath, size)}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={`lw-media-edge ${
        fit === "cover"
          ? "bg-zinc-100 object-cover dark:bg-zinc-800"
          : "max-h-full max-w-full object-contain"
      } ${className}`}
    />
  );
}

/**
 * A Frame View tile: the picture in its own shape on a letterbox, then the file's name and its
 * size, with what converting is estimated to leave when `ratio` is known.
 */
export function MediaTile({ row, ratio = null }: { row: FileRow; ratio?: number | null }) {
  return (
    <div className="min-w-0" title={row.relPath} data-file-name={row.name}>
      <div className="lw-well flex aspect-[4/3] items-center justify-center overflow-hidden">
        <Poster row={row} size={320} fit="contain" className="rounded-md" />
      </div>
      <div className="px-0.5 pt-1.5">
        <p className="truncate text-[13px]">{row.name}</p>
        <p className="lw-caption truncate">
          {formatBytes(row.size)}
          {ratio === null ? null : ` → ~${formatBytes(row.size * ratio)}`}
        </p>
      </div>
    </div>
  );
}
