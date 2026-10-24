import type { FileRow, SelectionSummary } from "@latch-works/glazier-core/contract";
import { FolderSearch, MousePointerClick } from "lucide-react";
import { type ReactNode, useState } from "react";

import { thumbnailUrl } from "../../lib/api";
import { formatBytes, formatDateTime, formatDuration, formatLabel, plural } from "../../lib/format";
import { Thumbnail } from "../media";
import { AUDIO_LABELS, convertLabel, convertTarget, KIND_LABELS } from "./labels";

/** The panel's inner width (320 px less 16 px padding each side), which bounds the preview. */
const PREVIEW_BOX = 288;

interface InspectorProps {
  /** The one file shown, when one is selected or under the cursor. */
  single: FileRow | null;
  /** Up to three of the files, for the stack shown when several are selected. */
  sample: FileRow[];
  count: number;
  summary: SelectionSummary | null;
  /** Whether Convert is the screen's primary action, or the selection bar's Convert is. */
  primary: boolean;
  onConvert: () => void;
  onReveal: () => void;
  onMoveTo: () => void;
  onHold: () => void;
}

/** Pane View's right panel: the file at a useful size, what can be done to it, then its facts. */
export function Inspector(props: InspectorProps) {
  const { single, sample, count, summary } = props;

  return (
    <aside
      aria-label="Inspector"
      className="flex w-80 shrink-0 flex-col overflow-y-auto border-l lw-divider p-4"
    >
      {count === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-16 text-center">
          <MousePointerClick className="size-8 text-zinc-300 dark:text-zinc-600" />
          <p className="lw-caption">Select a file to see it here</p>
        </div>
      ) : count === 1 ? (
        single ? (
          <>
            <Preview key={single.id} row={single} />
            <Actions {...props} convert={`Convert to ${convertTarget(single)}`} />
            <Details row={single} />
          </>
        ) : null
      ) : (
        <>
          <Stack rows={sample} />
          <p className="mt-3 text-center text-[13px] font-medium">
            {plural(count, "file")}
            {summary ? (
              <span className="font-normal text-zinc-500"> · {formatBytes(summary.bytes)}</span>
            ) : null}
          </p>
          <Actions
            {...props}
            convert={summary ? convertLabel(summary.convertible.files, summary.files) : "Convert"}
          />
        </>
      )}
    </aside>
  );
}

function Preview({ row }: { row: FileRow }) {
  const [failed, setFailed] = useState(false);

  const showable =
    (row.kind === "image" || row.kind === "video") && row.probeError === null && !failed;

  if (!showable) {
    return (
      <div className="lw-well flex h-40 shrink-0 items-center justify-center">
        <Thumbnail row={row} size={72} className="rounded-lg" />
      </div>
    );
  }

  // Sized from the file's own dimensions, so the panel does not jump when the picture arrives.
  const width = row.width ?? 16;
  const height = row.height ?? 9;
  const scale = Math.min(PREVIEW_BOX / width, PREVIEW_BOX / height);

  return (
    <div className="flex shrink-0 justify-center">
      <img
        src={thumbnailUrl(row.absPath, 640)}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        style={{ width: Math.round(width * scale), height: Math.round(height * scale) }}
        className="lw-media-edge rounded-xl bg-zinc-100 object-cover dark:bg-zinc-800"
      />
    </div>
  );
}

/** Up to three thumbnails fanned behind one another. */
function Stack({ rows }: { rows: FileRow[] }) {
  const tilts = ["-rotate-6 -translate-x-8", "rotate-6 translate-x-8", ""];

  return (
    <div className="relative flex h-40 shrink-0 items-center justify-center">
      {rows
        .slice(0, 3)
        .reverse()
        .map((row, position, shown) => (
          <div
            key={row.id}
            className={`absolute rounded-lg bg-white shadow-[var(--shadow-border)] dark:bg-zinc-900 ${
              tilts[position + 3 - shown.length] ?? ""
            }`}
          >
            <Thumbnail row={row} size={112} className="rounded-lg" />
          </div>
        ))}
    </div>
  );
}

function Actions({
  summary,
  count,
  primary,
  convert,
  onConvert,
  onReveal,
  onMoveTo,
  onHold,
}: InspectorProps & { convert: string }) {
  const convertible = summary !== null && summary.convertible.files > 0;

  return (
    <div className="mt-4 flex shrink-0 flex-col gap-2">
      {convertible ? (
        <button
          type="button"
          className={`lw-btn lw-btn-lg w-full ${primary ? "lw-btn-primary" : "lw-btn-secondary"}`}
          onClick={onConvert}
        >
          {convert}
        </button>
      ) : null}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <button
          type="button"
          className="lw-btn lw-btn-secondary min-w-0 px-2.5"
          title={count > 1 ? `Move ${plural(count, "file")} to holding  ⌘⌫` : "Move to holding  ⌘⌫"}
          onClick={onHold}
        >
          <span className="truncate">Move to holding</span>
        </button>
        <button
          type="button"
          className="lw-btn lw-btn-secondary min-w-0 px-2.5"
          title="Move to…  ⇧⌘M"
          onClick={onMoveTo}
        >
          <span className="truncate">Move to…</span>
        </button>
        <button
          type="button"
          className="lw-btn lw-btn-secondary lw-btn-icon"
          aria-label="Show in Finder"
          title={count > 1 ? "Show the first file in Finder  ⇧⌘R" : "Show in Finder  ⇧⌘R"}
          onClick={onReveal}
        >
          <FolderSearch />
        </button>
      </div>
    </div>
  );
}

function Details({ row }: { row: FileRow }) {
  const video = row.kind === "video";
  const issues = issuesOf(row);

  return (
    <dl className="mt-5 flex flex-col gap-3 border-t lw-divider pt-4">
      <Fact label="Path">
        <span className="break-all">{row.relPath}</span>
      </Fact>
      <Fact label="Format">
        {formatLabel(row.format)}
        <span className="text-zinc-500"> · {KIND_LABELS[row.kind]}</span>
      </Fact>
      {row.width !== null && row.height !== null ? (
        <Fact label="Dimensions">
          {row.width} × {row.height}
          {(row.frames ?? 1) > 1 ? (
            <span className="text-zinc-500"> · {plural(row.frames ?? 0, "frame")}</span>
          ) : null}
        </Fact>
      ) : null}
      {video && row.durationMs !== null ? (
        <Fact label="Duration">{formatDuration(row.durationMs)}</Fact>
      ) : null}
      {video && row.audioState ? <Fact label="Sound">{AUDIO_LABELS[row.audioState]}</Fact> : null}
      <Fact label="Size">{formatBytes(row.size)}</Fact>
      <Fact label="Modified">{formatDateTime(row.mtimeMs)}</Fact>
      {issues.length > 0 ? (
        <Fact label="Issues">
          <span className="text-amber-700 dark:text-amber-300">{issues.join(" · ")}</span>
        </Fact>
      ) : null}
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="lw-caption">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-zinc-900 dark:text-zinc-100">{children}</dd>
    </div>
  );
}

/** What is wrong with a file, as the Issues filter names it. */
function issuesOf(row: FileRow): string[] {
  const issues: string[] = [];

  if (row.probeError) {
    issues.push("Won't open");
  }

  if (row.size === 0) {
    issues.push("Empty file");
  }

  if (row.extensionMismatch) {
    issues.push(`Wrong extension (.${row.ext})`);
  }

  if (row.kind === "junk") {
    issues.push("System junk");
  }

  return issues;
}
