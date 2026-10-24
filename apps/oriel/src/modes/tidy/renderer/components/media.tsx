import type { FileKind, FileRow } from "@latch-works/glazier-core/contract";
import { FileAudio, FileIcon, FileText, FileVideo, ImageIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { thumbnailUrl } from "../lib/api";
import { codecLabel, formatDuration } from "../lib/format";

/** A file's dimensions, codec and length, as one short line. */
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

const KIND_ICONS = {
  image: ImageIcon,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  other: FileIcon,
  junk: FileIcon,
} as const satisfies Record<FileKind, LucideIcon>;

/**
 * A square thumbnail, or the kind's icon when the file has no picture to show. `fill` makes it
 * as wide as its box (a grid tile) and asks for a larger picture.
 */
export function Thumbnail({
  row,
  size = 24,
  fill = false,
  className = "rounded-md",
}: {
  row: FileRow;
  size?: number;
  fill?: boolean;
  /** The corner radius, and anything else the box needs. */
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  const showable =
    (row.kind === "image" || row.kind === "video") && row.probeError === null && !failed;

  const box = fill ? { width: "100%", aspectRatio: "1" } : { width: size, height: size };
  const Icon = KIND_ICONS[row.kind];

  return showable ? (
    <img
      src={thumbnailUrl(row.absPath, fill ? 384 : Math.max(64, size * 2))}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      style={box}
      className={`lw-media-edge block shrink-0 bg-zinc-100 object-cover dark:bg-zinc-800 ${className}`}
    />
  ) : (
    <span
      style={box}
      title={row.ext ? `.${row.ext}` : undefined}
      className={`flex shrink-0 flex-col items-center justify-center gap-1.5 bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500 ${className}`}
    >
      <Icon className={fill ? "size-8" : "size-[55%]"} strokeWidth={1.5} />
      {fill && row.ext ? <span className="text-xs font-medium uppercase">{row.ext}</span> : null}
    </span>
  );
}
