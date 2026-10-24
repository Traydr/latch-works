import type { AudioState, FileFormat, FileId, FileKind } from "../contract.js";

/** What the keeper rules compare about each copy in a group. */
export interface KeeperCandidate {
  id: FileId;
  relPath: string;
  kind: FileKind;
  format: FileFormat | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  audioState: AudioState | null;
  size: number;
  mtimeMs: number;
  /** Inside a folder the owner marked protected. */
  isProtected: boolean;
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

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Positive when `left` is the better copy to keep. Each rule only breaks ties of the one before. */
type KeeperRule = (left: KeeperCandidate, right: KeeperCandidate) => number;

/**
 * Which copy of a picture or video to keep, in order: anything in a protected folder; for video,
 * the copy you can hear; more pixels; a longer video (to half a second, so a trimmed re-upload
 * loses); the archive format; more bytes, which at equal pixels is more detail; the oldest file;
 * the shortest path; and finally natural name order, so the choice never depends on scan order.
 */
const KEEPER_RULES: readonly KeeperRule[] = [
  (left, right) => Number(left.isProtected) - Number(right.isProtected),
  (left, right) =>
    (left.audioState ? AUDIO_RANK[left.audioState] : 0) -
    (right.audioState ? AUDIO_RANK[right.audioState] : 0),
  (left, right) => pixels(left) - pixels(right),
  (left, right) =>
    Math.round((left.durationMs ?? 0) / 500) - Math.round((right.durationMs ?? 0) / 500),
  (left, right) => Number(isArchiveFormat(left)) - Number(isArchiveFormat(right)),
  (left, right) => left.size - right.size,
  (left, right) => Math.trunc(right.mtimeMs) - Math.trunc(left.mtimeMs),
  (left, right) => right.relPath.length - left.relPath.length,
  (left, right) => naturalOrder.compare(right.relPath, left.relPath),
];

function pixels(candidate: KeeperCandidate): number {
  return (candidate.width ?? 0) * (candidate.height ?? 0);
}

function compareKeepers(left: KeeperCandidate, right: KeeperCandidate): number {
  for (const rule of KEEPER_RULES) {
    const result = rule(left, right);

    if (result !== 0) {
      return result;
    }
  }

  return 0;
}

/** The group's copies, best keeper first. */
export function rankKeepers<T extends KeeperCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) => compareKeepers(right, left));
}
