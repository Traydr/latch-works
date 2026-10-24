import type { FileRow } from "@latch-works/glazier-core/contract";
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

/** A square thumbnail, or the extension when the file has no picture to show. */
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
