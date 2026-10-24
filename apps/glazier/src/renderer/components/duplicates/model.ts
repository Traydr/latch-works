import {
  type DuplicateSet,
  type FileId,
  type FileRow,
  isCloseCall,
} from "@latch-works/glazier-core/contract";

import { formatBytes, formatDateTime, formatDuration, formatLabel } from "../../lib/format";

/** One tile of a set: a version, or for identical copies, one copy. */
export interface SetRow {
  file: FileRow;
  /** Byte-identical copies that go with this version. */
  copies: FileRow[];
}

export function rowsOf(set: DuplicateSet): SetRow[] {
  if (set.kind === "exact") {
    return (set.versions[0]?.files ?? []).map((file) => ({ file, copies: [] }));
  }

  return set.versions.flatMap((version) => {
    const [file, ...copies] = version.files;

    return file ? [{ file, copies }] : [];
  });
}

export function filesOf(set: DuplicateSet): FileRow[] {
  return set.versions.flatMap((version) => version.files);
}

/** Whether the owner's choice of keepers still names files of this set. */
export function fitsSet(set: DuplicateSet, keep: readonly FileId[]): boolean {
  const members = new Set(filesOf(set).map((file) => file.id));

  return keep.length > 0 && keep.every((id) => members.has(id));
}

/** What resolving keeps: the owner's choice when it still fits the set, else the suggestion. */
export function keptIds(set: DuplicateSet, override: readonly FileId[] | undefined): FileId[] {
  return override && fitsSet(set, override) ? [...override] : set.keep;
}

export function removalOf(set: DuplicateSet, kept: readonly FileId[]): FileRow[] {
  const keep = new Set(kept);

  return filesOf(set).filter((file) => !keep.has(file.id));
}

export function freedBytes(set: DuplicateSet, removed: readonly FileRow[]): number {
  const linked = new Set(set.hardLinkedIds);

  return removed.reduce((sum, file) => sum + (linked.has(file.id) ? 0 : file.size), 0);
}

function pixelsOf(file: FileRow): number | null {
  return file.width !== null && file.height !== null ? file.width * file.height : null;
}

function dimensionsOf(file: FileRow): string | null {
  return file.width !== null && file.height !== null ? `${file.width}×${file.height}` : null;
}

function ratioLabel(ratio: number, noun: string): string | null {
  if (ratio > 0.97 && ratio < 1.03) {
    return null;
  }

  if (ratio < 1) {
    return ratio <= 0.55
      ? `1/${Math.round(1 / ratio)} the ${noun}`
      : `${Math.round(ratio * 100)}% of the ${noun}`;
  }

  return `${ratio.toFixed(ratio >= 10 ? 0 : 1)}× the ${noun}`;
}

/** One fact under a tile; `worse` ones are what this version loses against the keeper. */
export interface Fact {
  text: string;
  worse: boolean;
}

/** A version's facts, each compared with the keeper's where a loss would matter. */
export function factsOf(file: FileRow, keeper: FileRow): Fact[] {
  const facts: Fact[] = [];
  const self = file.id === keeper.id;
  const dimensions = dimensionsOf(file);

  if (dimensions) {
    const pixels = pixelsOf(file);
    const keeperPixels = pixelsOf(keeper);
    const ratio = !self && pixels !== null && keeperPixels ? pixels / keeperPixels : 1;
    const label = ratio < 0.97 ? ratioLabel(ratio, "pixels") : null;

    facts.push({ text: label ? `${dimensions} (${label})` : dimensions, worse: label !== null });
  }

  if (file.kind === "video" && file.durationMs !== null) {
    const seconds =
      self || keeper.durationMs === null
        ? 0
        : Math.round((file.durationMs - keeper.durationMs) / 1000);

    facts.push({
      text:
        seconds < 0
          ? `${formatDuration(file.durationMs)} (${-seconds} s shorter)`
          : formatDuration(file.durationMs),
      worse: seconds < 0,
    });
  }

  if (file.kind === "video" && file.audioState !== null) {
    const silent = file.audioState === "none" || file.audioState === "silent";

    facts.push({
      text: file.audioState === "none" ? "no sound track" : silent ? "silent" : "sound",
      worse: !self && silent && keeper.audioState === "sound",
    });
  }

  facts.push({ text: formatBytes(file.size), worse: false });
  facts.push({ text: formatLabel(file.format), worse: false });

  return facts;
}

function versionNumbers(numbers: readonly number[]): string {
  if (numbers.length <= 1) {
    return String(numbers[0] ?? "");
  }

  return `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

/**
 * What keeping every version is called: for byte-identical copies it keeps both (or all), for
 * similar versions it says they are not duplicates.
 */
export function keepEveryLabel(set: DuplicateSet, rows: readonly SetRow[]): string {
  if (set.kind === "similar") {
    return "Not duplicates";
  }

  return rows.length === 2 ? "Keep both" : `Keep all ${rows.length}`;
}

/** The primary button's label: the versions it keeps, by number. */
export function decisionLabel(
  set: DuplicateSet,
  rows: readonly SetRow[],
  kept: ReadonlySet<FileId>,
): string {
  const keptNumbers = rows.flatMap((row, index) => (kept.has(row.file.id) ? [index + 1] : []));

  if (keptNumbers.length === rows.length) {
    return keepEveryLabel(set, rows);
  }

  return `Keep ${versionNumbers(keptNumbers)}`;
}

/**
 * Where resolving sends files, naming the copies a tile only mentions, so the count never
 * disagrees with the versions on screen: "3 versions and 2 copies go to holding · 120 KB".
 */
export function holdingSummary(
  set: DuplicateSet,
  rows: readonly SetRow[],
  kept: ReadonlySet<FileId>,
): string {
  const removed = removalOf(set, [...kept]);

  if (removed.length === 0) {
    return "Nothing goes to holding";
  }

  const bytes = formatBytes(freedBytes(set, removed));

  if (set.kind === "exact") {
    return `${removed.length === 1 ? "1 copy goes" : `${removed.length} copies go`} to holding · ${bytes}`;
  }

  const versions = rows.filter((row) => !kept.has(row.file.id)).length;
  const copies = removed.length - versions;

  const parts = [
    versions > 0 ? (versions === 1 ? "1 version" : `${versions} versions`) : null,
    copies > 0 ? (copies === 1 ? "1 copy" : `${copies} copies`) : null,
  ].filter(Boolean);

  return `${parts.join(" and ")} ${removed.length === 1 ? "goes" : "go"} to holding · ${bytes}`;
}

/** The line under a tile that names its hidden identical copies, in the present tense. */
export function copiesLine(row: SetRow): string | null {
  const [first] = row.copies;

  if (!first) {
    return null;
  }

  const where = first.dir || "the top folder";

  return row.copies.length === 1
    ? `Its copy in ${where} goes too`
    : `Its ${row.copies.length} copies go too`;
}

/** Why the suggested version is the one to keep, naming the value that decided it. */
export interface Reason {
  text: string;
  closeCall: boolean;
}

export function reasonOf(
  set: DuplicateSet,
  rows: readonly SetRow[],
  kept: readonly FileId[],
  overridden: boolean,
): Reason {
  const keptNumbers = rows.flatMap((row, index) => (kept.includes(row.file.id) ? [index + 1] : []));

  if (overridden) {
    return {
      text:
        keptNumbers.length === rows.length
          ? "You are keeping every version"
          : `Your pick: keep ${versionNumbers(keptNumbers)}`,
      closeCall: false,
    };
  }

  const keeperIndex = rows.findIndex((row) => row.file.id === set.keep[0]);
  const keeper = rows[keeperIndex]?.file;
  const runnerIndex = keeperIndex === 0 ? 1 : 0;
  const runner = rows[runnerIndex]?.file;
  const n = keeperIndex + 1;
  const m = runnerIndex + 1;

  if (!keeper) {
    return { text: "", closeCall: false };
  }

  const folder = keeper.dir || "The top folder";
  const closeCall = isCloseCall(set);
  const reason = (text: string) => ({ text, closeCall });

  switch (set.keepReason) {
    case "preferred-folder":
      return reason(`Keeping ${n}: ${folder} is a preferred folder`);
    case "has-sound":
      return reason(`Keeping ${n}: it has sound, ${m} does not`);
    case "more-pixels":
      return reason(
        `Keeping ${n}: most pixels (${dimensionsOf(keeper)} against ${
          runner ? (dimensionsOf(runner) ?? "unknown") : "unknown"
        })`,
      );
    case "longer":
      return reason(
        `Keeping ${n}: longest (${formatDuration(keeper.durationMs)} against ${formatDuration(
          runner?.durationMs ?? null,
        )})`,
      );
    case "archive-format":
      return reason(`Keeping ${n}: already ${formatLabel(keeper.format)}`);
    case "right-extension":
      return reason(`Keeping ${n}: its extension matches its contents`);
    case "original-name":
      return reason(`Keeping ${n}: ${runner?.name ?? m} looks like a copy`);
    case "larger-file":
      return reason(
        closeCall
          ? `Close call: ${n} is only ${formatBytes(
              Math.max(0, keeper.size - (runner?.size ?? 0)),
            )} larger`
          : `Keeping ${n}: the largest file, so the least compressed`,
      );
    case "oldest":
      return reason(
        set.kind === "exact"
          ? `Keeping ${n}: the oldest copy (${formatDateTime(keeper.mtimeMs)})`
          : `Close call: ${n} is the oldest`,
      );
    case "shorter-path":
      return reason(
        set.kind === "exact"
          ? `Keeping ${n}: the shortest path`
          : `Close call: ${n} has the shortest path`,
      );
    case "name-order":
      return reason(
        set.kind === "exact"
          ? `Keeping ${n}: first by name`
          : `Close call: ${n} comes first by name`,
      );
    default: {
      const _exhaustive: never = set.keepReason;

      return _exhaustive;
    }
  }
}
