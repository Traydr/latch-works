import type { AudioState, FileFormat, FileId, FileKind, KeepReason } from "../contract.js";
import { preferredExtension } from "../scan/sniff.js";

/** What the keeper rules compare about each copy in a group. */
export interface KeeperCandidate {
  id: FileId;
  relPath: string;
  kind: FileKind;
  format: FileFormat | null;
  /** Lowercased, without the dot. */
  ext: string;
  /** The extension names a different format than the bytes hold. */
  extensionMismatch: boolean;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  audioState: AudioState | null;
  size: number;
  mtimeMs: number;
  /** Inside a folder the owner prefers to keep copies in. */
  isPreferred: boolean;
}

/** Hearing something beats not knowing, which beats a silent track, which beats no track. */
const AUDIO_RANK = { sound: 3, unmeasured: 2, silent: 1, none: 0 } as const satisfies Record<
  AudioState,
  number
>;

const ARCHIVE_VIDEO_CODECS = new Set(["h264", "hevc", "av1"]);

/** Already in the archive format: an AVIF still, or MP4 with a codec the archive keeps. */
function isArchiveFormat(candidate: KeeperCandidate): boolean {
  if (candidate.kind === "image") {
    return candidate.format === "avif";
  }

  return candidate.format === "mp4" && ARCHIVE_VIDEO_CODECS.has(candidate.videoCodec ?? "");
}

/** 2 for the format's own extension (`.mp4`), 1 for another it accepts (`.m4v`), 0 for a wrong one. */
function extensionRank(candidate: KeeperCandidate): number {
  if (candidate.extensionMismatch) {
    return 0;
  }

  const preferred = candidate.format === null ? null : preferredExtension(candidate.format);

  return preferred !== null && candidate.ext === preferred ? 2 : 1;
}

/** ` (1)`, ` copy`, ` copy 2`, `-copy`, `_copy`, ` 2`: what systems append to a copy's name. */
const COPY_SUFFIX = /^(?: \(\d+\)| copy(?: \d+)?|[-_]copy(?:[-_ ]?\d+)?| \d+)$/i;

function stemOf(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");

  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/** True when `copy` is named like `original` plus a copy suffix: `sunset (1)` beside `sunset`. */
function isCopyNameOf(copy: KeeperCandidate, original: KeeperCandidate): boolean {
  const copyStem = stemOf(copy.relPath);
  const originalStem = stemOf(original.relPath);

  return (
    copyStem.length > originalStem.length &&
    copyStem.startsWith(originalStem) &&
    COPY_SUFFIX.test(copyStem.slice(originalStem.length))
  );
}

function pixels(candidate: KeeperCandidate): number {
  return (candidate.width ?? 0) * (candidate.height ?? 0);
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Positive when `left` is the better copy to keep. Each rule only breaks ties of the one before. */
type KeeperComparison = (left: KeeperCandidate, right: KeeperCandidate) => number;

/**
 * Which copy of a picture or video to keep, in order: anything in a preferred folder; for video,
 * the copy you can hear; more pixels; a longer video (to half a second, so a trimmed re-upload
 * loses); the archive format; the extension the format is named with; more bytes, which at equal
 * pixels is more detail; the name without a copy suffix; the oldest file; the shortest path; and
 * finally natural name order, so the choice never depends on scan order.
 */
const KEEPER_RULES = [
  {
    reason: "preferred-folder",
    compare: (left, right) => Number(left.isPreferred) - Number(right.isPreferred),
  },
  {
    reason: "has-sound",
    compare: (left, right) =>
      (left.audioState ? AUDIO_RANK[left.audioState] : 0) -
      (right.audioState ? AUDIO_RANK[right.audioState] : 0),
  },
  { reason: "more-pixels", compare: (left, right) => pixels(left) - pixels(right) },
  {
    reason: "longer",
    compare: (left, right) =>
      Math.round((left.durationMs ?? 0) / 500) - Math.round((right.durationMs ?? 0) / 500),
  },
  {
    reason: "archive-format",
    compare: (left, right) => Number(isArchiveFormat(left)) - Number(isArchiveFormat(right)),
  },
  {
    reason: "right-extension",
    compare: (left, right) => extensionRank(left) - extensionRank(right),
  },
  { reason: "larger-file", compare: (left, right) => left.size - right.size },
  {
    reason: "original-name",
    compare: (left, right) => Number(isCopyNameOf(right, left)) - Number(isCopyNameOf(left, right)),
  },
  {
    reason: "oldest",
    compare: (left, right) => Math.trunc(right.mtimeMs) - Math.trunc(left.mtimeMs),
  },
  {
    reason: "shorter-path",
    compare: (left, right) => right.relPath.length - left.relPath.length,
  },
  {
    reason: "name-order",
    compare: (left, right) => naturalOrder.compare(right.relPath, left.relPath),
  },
] as const satisfies readonly { reason: KeepReason; compare: KeeperComparison }[];

function compareKeepers(left: KeeperCandidate, right: KeeperCandidate): number {
  for (const rule of KEEPER_RULES) {
    const result = rule.compare(left, right);

    if (result !== 0) {
      return result;
    }
  }

  return 0;
}

/**
 * The first rule that tells two copies apart, which is why the winner is kept. Copies no rule
 * separates (the same path in two roots) are told apart by name order.
 */
export function keepReason(winner: KeeperCandidate, loser: KeeperCandidate): KeepReason {
  for (const rule of KEEPER_RULES) {
    if (rule.compare(winner, loser) !== 0) {
      return rule.reason;
    }
  }

  return "name-order";
}

export interface KeeperRanking<T extends KeeperCandidate> {
  /** Best keeper first. */
  ranked: T[];
  /** Why the first beat the second; null with fewer than two candidates. */
  reason: KeepReason | null;
}

/** The group's copies, best keeper first, and the rule that put the first ahead of the second. */
export function rankKeepers<T extends KeeperCandidate>(candidates: readonly T[]): KeeperRanking<T> {
  const ranked = [...candidates].sort((left, right) => compareKeepers(right, left));
  const [first, second] = ranked;

  return {
    ranked,
    reason: first !== undefined && second !== undefined ? keepReason(first, second) : null,
  };
}
