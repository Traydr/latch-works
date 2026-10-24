import {
  type AudioState,
  type FileFlag,
  FileFlagSchema,
  type FileKind,
  type FileRow,
} from "@latch-works/glazier-core/contract";

import { formatCount } from "../../lib/format";

export const KIND_LABELS = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  pdf: "PDFs",
  other: "Other",
  junk: "System junk",
} as const satisfies Record<FileKind, string>;

export const AUDIO_LABELS = {
  none: "No audio track",
  silent: "Silent track",
  sound: "Has sound",
  unmeasured: "Not measured yet",
} as const satisfies Record<AudioState, string>;

export const FLAG_LABELS = {
  duplicate: "Duplicates",
  convertible: "Can be converted",
  "extension-mismatch": "Wrong extension",
  undecodable: "Won't open",
  "zero-byte": "Empty files",
  animated: "Animated",
  unsupported: "No app shows these",
  junk: "System junk",
} as const satisfies Record<FileFlag, string>;

/** The Issues group; junk is a kind, so the Kind group covers it. */
export const ISSUE_FLAGS = FileFlagSchema.options.filter((flag) => flag !== "junk");

/** A video nobody can hear: no audio track, or a track that is silent. */
export function isMuteVideo(row: FileRow): boolean {
  return row.kind === "video" && (row.audioState === "none" || row.audioState === "silent");
}

/** What converting the file makes: stills become AVIF, everything that moves becomes MP4. */
export function convertTarget(row: FileRow): "AVIF" | "MP4" {
  return row.kind === "video" || (row.frames ?? 1) > 1 ? "MP4" : "AVIF";
}

/** "Convert 3", or "Convert 1 of 3" when only some of the files can be converted. */
export function convertLabel(convertible: number, files: number): string {
  return convertible < files
    ? `Convert ${formatCount(convertible)} of ${formatCount(files)}`
    : `Convert ${formatCount(convertible)}`;
}
