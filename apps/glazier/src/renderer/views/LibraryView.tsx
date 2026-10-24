import type {
  AudioState,
  FileFlag,
  FileId,
  FileKind,
  FileRow,
  RootId,
  VideoCodecChoice,
  VideoQuality,
} from "@latch-works/glazier-core/contract";
import { Eye, FolderInput, FolderOpen, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type FileFilter, FileTable } from "../components/FileTable";
import { usePlanner } from "../components/PlanDialog";
import { Modal, Toggle, ViewHeader } from "../components/ui";
import { call, desktop } from "../lib/api";
import { useEngine } from "../lib/engine-state";
import { formatBytes, formatCount } from "../lib/format";
import { EMPTY_PRESET, useNavigation } from "../lib/navigation";

const KIND_CHIPS = [
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "pdf", label: "PDFs" },
  { value: "other", label: "Other" },
  { value: "junk", label: "Junk" },
] as const satisfies ReadonlyArray<{ value: FileKind; label: string }>;

const AUDIO_CHIPS = [
  { value: "none", label: "No audio track" },
  { value: "silent", label: "Silent track" },
  { value: "sound", label: "Has sound" },
  { value: "unmeasured", label: "Not measured" },
] as const satisfies ReadonlyArray<{ value: AudioState; label: string }>;

const FLAG_CHIPS = [
  { value: "duplicate", label: "Duplicates" },
  { value: "extension-mismatch", label: "Wrong extension" },
  { value: "undecodable", label: "Won't decode" },
  { value: "zero-byte", label: "Zero bytes" },
  { value: "animated", label: "Animated" },
  { value: "unsupported", label: "Unsupported" },
] as const satisfies ReadonlyArray<{ value: FileFlag; label: string }>;

const SORTS = [
  { value: "path", label: "Path" },
  { value: "name", label: "Name" },
  { value: "size", label: "Size" },
  { value: "mtime", label: "Modified" },
  { value: "kind", label: "Format" },
  { value: "duration", label: "Duration" },
] as const satisfies ReadonlyArray<{ value: FileFilter["sort"]; label: string }>;

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`ls-chip ${on ? "ls-chip-on" : ""}`}
    >
      {label}
    </button>
  );
}

export function LibraryView({ rootId }: { rootId: RootId }) {
  const { preset } = useNavigation();
  const { propose } = usePlanner();
  const { report, capabilities, settings } = useEngine();

  const [filter, setFilter] = useState<FileFilter>(() => ({
    rootId,
    ...EMPTY_PRESET,
    ...preset,
    dir: null,
    sort: "path",
    descending: false,
  }));

  const [search, setSearch] = useState(preset.search);
  const [selected, setSelected] = useState<Set<FileId>>(new Set());
  const [totals, setTotals] = useState<{ total: number; bytes: number } | null>(null);
  const [selectedRows, setSelectedRows] = useState<FileRow[]>([]);
  const [dialog, setDialog] = useState<"rename" | "reencode" | null>(null);

  // Another view linked here with a filter: apply it.
  useEffect(() => {
    setFilter((current) => ({ ...current, ...EMPTY_PRESET, ...preset, rootId }));
    setSearch(preset.search);
    setSelected(new Set());
  }, [preset, rootId]);

  // Search applies after typing pauses.
  useEffect(() => {
    const timer = window.setTimeout(() => setFilter((current) => ({ ...current, search })), 250);

    return () => window.clearTimeout(timer);
  }, [search]);

  // The selected rows' details, for the actions that need names and kinds.
  useEffect(() => {
    if (selected.size === 0 || selected.size > 500) {
      setSelectedRows([]);

      return;
    }

    let cancelled = false;

    call("getFiles", { ids: [...selected] }).then(
      (rows) => {
        if (!cancelled) {
          setSelectedRows(rows);
        }
      },
      () => undefined,
    );

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const onTotals = useCallback((next: { total: number; bytes: number }) => setTotals(next), []);

  const ids = useMemo(() => [...selected], [selected]);
  const single = selectedRows.length === 1 ? selectedRows[0] : undefined;
  const onlyVideos = selectedRows.length > 0 && selectedRows.every((row) => row.kind === "video");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Library"
        description={
          totals
            ? `${formatCount(totals.total)} files · ${formatBytes(totals.bytes)}`
            : "Every file in this root."
        }
      >
        <label className="relative block w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            className="ls-input text-xs"
            style={{ paddingLeft: 28, paddingTop: 4, paddingBottom: 4 }}
            placeholder="Search names and paths"
            aria-label="Search names and paths"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <select
          className="ls-input text-xs"
          style={{ width: 112, paddingTop: 4, paddingBottom: 4 }}
          aria-label="Sort by"
          value={filter.sort}
          onChange={(event) => {
            const sort = SORTS.find((entry) => entry.value === event.target.value)?.value;

            if (sort) {
              setFilter((current) => ({ ...current, sort }));
            }
          }}
        >
          {SORTS.map((sort) => (
            <option key={sort.value} value={sort.value}>
              {sort.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ls-btn"
          onClick={() => setFilter((current) => ({ ...current, descending: !current.descending }))}
        >
          {filter.descending ? "Descending" : "Ascending"}
        </button>
      </ViewHeader>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b ls-divider px-5 py-2">
        {KIND_CHIPS.map((chip) => (
          <Chip
            key={chip.value}
            label={chip.label}
            on={filter.kinds.includes(chip.value)}
            onClick={() =>
              setFilter((current) => ({ ...current, kinds: toggle(current.kinds, chip.value) }))
            }
          />
        ))}
        <span className="mx-1 h-4 border-l ls-divider" />
        {AUDIO_CHIPS.map((chip) => (
          <Chip
            key={chip.value}
            label={chip.label}
            on={filter.audioStates.includes(chip.value)}
            onClick={() =>
              setFilter((current) => ({
                ...current,
                audioStates: toggle(current.audioStates, chip.value),
              }))
            }
          />
        ))}
        <span className="mx-1 h-4 border-l ls-divider" />
        {FLAG_CHIPS.map((chip) => (
          <Chip
            key={chip.value}
            label={chip.label}
            on={filter.flags.includes(chip.value)}
            onClick={() =>
              setFilter((current) => ({ ...current, flags: toggle(current.flags, chip.value) }))
            }
          />
        ))}
        {filter.formats.length > 0 ? (
          <Chip
            on
            label={`Formats: ${filter.formats.join(", ")} ×`}
            onClick={() => setFilter((current) => ({ ...current, formats: [] }))}
          />
        ) : null}
      </div>

      <FileTable filter={filter} selected={selected} onSelect={setSelected} onTotals={onTotals} />

      {selected.size > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t ls-divider bg-zinc-50 px-5 py-2 dark:bg-zinc-900/60">
          <span className="mr-2 text-xs font-medium">{formatCount(selected.size)} selected</span>
          <button
            type="button"
            className="ls-btn ls-btn-danger"
            onClick={() =>
              propose(`Move ${formatCount(ids.length)} files to holding`, {
                kind: "hold",
                fileIds: ids,
              })
            }
          >
            Move to holding
          </button>
          <button
            type="button"
            className="ls-btn"
            onClick={async () => {
              const targetDir = await desktop.pickFolder().catch(report);

              if (targetDir) {
                propose(`Move ${formatCount(ids.length)} files`, {
                  kind: "move",
                  fileIds: ids,
                  targetDir,
                });
              }
            }}
          >
            <FolderInput className="size-3.5" /> Move to…
          </button>
          <button
            type="button"
            className="ls-btn"
            disabled={!single}
            onClick={() => setDialog("rename")}
          >
            Rename…
          </button>
          <button
            type="button"
            className="ls-btn"
            onClick={() => propose("Fix extensions", { kind: "fix-extension", fileIds: ids })}
          >
            Fix extension
          </button>
          <button
            type="button"
            className="ls-btn ls-btn-primary"
            onClick={() =>
              propose("Convert to the archive formats", {
                kind: "optimize",
                rootId,
                categories: [
                  "still-to-avif",
                  "animation-to-mp4",
                  "video-remux",
                  "video-convert",
                  "rename-avif",
                  "rename-mp4",
                ],
                fileIds: ids,
              })
            }
          >
            Convert to archive format
          </button>
          <button
            type="button"
            className="ls-btn"
            disabled={!onlyVideos}
            onClick={() => setDialog("reencode")}
          >
            Re-encode…
          </button>
          <button
            type="button"
            className="ls-btn"
            disabled={!onlyVideos}
            onClick={() => propose("Remove the audio track", { kind: "strip-audio", fileIds: ids })}
          >
            Strip audio
          </button>
          <span className="ml-auto flex gap-1.5">
            <button
              type="button"
              className="ls-btn ls-btn-ghost"
              disabled={!single}
              onClick={() => single && void desktop.reveal(single.absPath)}
            >
              <FolderOpen className="size-3.5" /> Reveal
            </button>
            <button
              type="button"
              className="ls-btn ls-btn-ghost"
              disabled={!single}
              onClick={() => single && void desktop.quickLook(single.absPath)}
            >
              <Eye className="size-3.5" /> Quick Look
            </button>
          </span>
        </div>
      ) : null}

      {dialog === "rename" && single ? (
        <RenameDialog
          row={single}
          onClose={() => setDialog(null)}
          onRename={(name) => {
            setDialog(null);
            propose(`Rename ${single.name}`, {
              kind: "rename",
              renames: [{ fileId: single.id, name }],
            });
          }}
        />
      ) : null}

      {dialog === "reencode" ? (
        <ReencodeDialog
          count={ids.length}
          defaults={{
            codec: settings?.reencodeCodec ?? "hevc",
            quality: settings?.reencodeQuality ?? "high",
          }}
          available={capabilities?.video ?? { avc: false, hevc: false, av1: false }}
          onClose={() => setDialog(null)}
          onConfirm={(codec, quality) => {
            setDialog(null);
            propose(`Re-encode ${formatCount(ids.length)} videos`, {
              kind: "reencode",
              fileIds: ids,
              codec,
              quality,
            });
          }}
        />
      ) : null}
    </div>
  );
}

function RenameDialog({
  row,
  onClose,
  onRename,
}: {
  row: FileRow;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(row.name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  return (
    <Modal
      title={`Rename ${row.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ls-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ls-btn ls-btn-cta"
            disabled={!name.trim() || name === row.name}
            onClick={() => onRename(name.trim())}
          >
            Review rename
          </button>
        </>
      }
    >
      <input
        className="ls-input"
        aria-label="New name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        ref={input}
      />
    </Modal>
  );
}

const CODEC_OPTIONS = [
  { value: "avc", label: "H.264" },
  { value: "hevc", label: "HEVC" },
  { value: "av1", label: "AV1" },
] as const satisfies ReadonlyArray<{ value: VideoCodecChoice; label: string }>;

const QUALITY_OPTIONS = [
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "very-high", label: "Very high" },
] as const satisfies ReadonlyArray<{ value: VideoQuality; label: string }>;

function ReencodeDialog({
  count,
  defaults,
  available,
  onClose,
  onConfirm,
}: {
  count: number;
  defaults: { codec: VideoCodecChoice; quality: VideoQuality };
  available: Record<VideoCodecChoice, boolean>;
  onClose: () => void;
  onConfirm: (codec: VideoCodecChoice, quality: VideoQuality) => void;
}) {
  const [codec, setCodec] = useState<VideoCodecChoice>(
    available[defaults.codec] ? defaults.codec : "avc",
  );

  const [quality, setQuality] = useState<VideoQuality>(defaults.quality);

  return (
    <Modal
      title={`Re-encode ${formatCount(count)} videos`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ls-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ls-btn ls-btn-cta"
            disabled={!available[codec]}
            onClick={() => onConfirm(codec, quality)}
          >
            Review re-encode
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-zinc-500">Codec</span>
          <Toggle
            label="Codec"
            value={codec}
            onChange={setCodec}
            options={CODEC_OPTIONS.map((option) => ({
              ...option,
              disabled: !available[option.value],
            }))}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-zinc-500">Quality</span>
          <Toggle label="Quality" value={quality} onChange={setQuality} options={QUALITY_OPTIONS} />
        </div>
        <p className="text-zinc-500">
          Re-encoding is lossy and runs on this Mac's WebCodecs encoders. A result that is not at
          least 5% smaller keeps the original. Output is always MP4.
        </p>
        {codec === "av1" ? (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-200">
            Older devices cannot play AV1. Keep H.264 or HEVC for anything you watch on them.
          </p>
        ) : null}
        {!available.hevc || !available.av1 ? (
          <p className="text-zinc-500">Codecs this machine cannot encode are greyed out.</p>
        ) : null}
      </div>
    </Modal>
  );
}
