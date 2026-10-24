import type { AudioCodec, VideoCodec } from "mediabunny";

import { getFileExtension, replaceFileExtension } from "./file-names.js";

/**
 * The archive keeps one video container, MP4. These video codecs are stored as they are when a
 * file moves into MP4; H.264 plays everywhere, HEVC and AV1 only on newer devices, so nothing is
 * re-encoded into them unless the owner asks for it.
 */
export const ARCHIVE_VIDEO_CODECS = ["avc", "hevc", "av1"] as const satisfies readonly VideoCodec[];

export type ArchiveVideoCodec = (typeof ARCHIVE_VIDEO_CODECS)[number];

/** Audio codecs MP4 players accept everywhere; other audio becomes AAC. */
export const ARCHIVE_AUDIO_CODECS = ["aac", "mp3"] as const satisfies readonly AudioCodec[];

/** The codec a video track is re-encoded to when its own codec is not an archive codec. */
export const ARCHIVE_DEFAULT_VIDEO_CODEC: ArchiveVideoCodec = "avc";

/**
 * A video file's container as read from its first bytes. Mediabunny reads the first five, so only
 * those can be converted; the rest are reported.
 */
export const VIDEO_CONTAINERS = [
  "mp4",
  "mov",
  "matroska",
  "webm",
  "mpegts",
  "avi",
  "flv",
  "asf",
] as const;

export type VideoContainer = (typeof VIDEO_CONTAINERS)[number];

const CONVERTIBLE_CONTAINERS = new Set<VideoContainer>([
  "mp4",
  "mov",
  "matroska",
  "webm",
  "mpegts",
]);

/** What the policy needs to know about a video file, decoded from a probe at its boundary. */
export interface ArchiveVideoSource {
  fileName: string;
  container: VideoContainer;
  /** The primary video track's codec; `"other"` for one Mediabunny does not name. */
  videoCodec: VideoCodec | "other" | null;
  /** The primary audio track's codec, or null when the file has no audio. */
  audioCodec: AudioCodec | "other" | null;
}

export type VideoTrackPlan = { action: "copy" } | { action: "encode"; codec: ArchiveVideoCodec };

export type AudioTrackPlan = { action: "copy" } | { action: "encode-aac" } | { action: "drop" };

export type ArchiveVideoPlan =
  | { action: "rename-mp4"; fileName: string }
  | {
      action: "convert-mp4";
      fileName: string;
      video: VideoTrackPlan;
      audio: AudioTrackPlan;
    }
  | { action: "unsupported"; reason: string };

/**
 * Plans how a video file reaches the archive format: MP4 with archive codecs. Returns null when
 * the file already is one. Tracks that already use an archive codec are copied, so moving an
 * H.264 MKV or MOV into MP4 is lossless.
 */
export function planArchiveVideo(source: ArchiveVideoSource): ArchiveVideoPlan | null {
  if (!CONVERTIBLE_CONTAINERS.has(source.container)) {
    return {
      action: "unsupported",
      reason: `The ${source.container.toUpperCase()} container cannot be read for conversion.`,
    };
  }

  if (source.videoCodec === null) {
    return { action: "unsupported", reason: "The file has no video track." };
  }

  const video = planVideoTrack(source.videoCodec);
  const audio = planAudioTrack(source.audioCodec);
  const mp4FileName = replaceFileExtension(source.fileName, "mp4");

  if (source.container === "mp4" && video.action === "copy" && audio.action === "copy") {
    return getFileExtension(source.fileName) === "mp4"
      ? null
      : { action: "rename-mp4", fileName: mp4FileName };
  }

  return { action: "convert-mp4", fileName: mp4FileName, video, audio };
}

/**
 * Plans an explicit re-encode of a video into `codec`, inside MP4. Audio is copied when it is
 * already an archive codec. This is never chosen automatically; the owner asks for it.
 */
export function planVideoReencode(
  source: ArchiveVideoSource,
  codec: ArchiveVideoCodec,
): ArchiveVideoPlan {
  if (!CONVERTIBLE_CONTAINERS.has(source.container) || source.videoCodec === null) {
    return { action: "unsupported", reason: "This file cannot be re-encoded." };
  }

  return {
    action: "convert-mp4",
    fileName: replaceFileExtension(source.fileName, "mp4"),
    video: { action: "encode", codec },
    audio: planAudioTrack(source.audioCodec),
  };
}

/** Plans removing the audio from a video while copying its picture into MP4 as-is. */
export function planStripAudio(source: ArchiveVideoSource): ArchiveVideoPlan {
  if (!CONVERTIBLE_CONTAINERS.has(source.container) || source.videoCodec === null) {
    return { action: "unsupported", reason: "This file cannot be rewritten without its audio." };
  }

  return {
    action: "convert-mp4",
    fileName: replaceFileExtension(source.fileName, "mp4"),
    video: planVideoTrack(source.videoCodec),
    audio: { action: "drop" },
  };
}

export function isArchiveVideoCodec(codec: VideoCodec | "other"): codec is ArchiveVideoCodec {
  return ARCHIVE_VIDEO_CODECS.some((archiveCodec) => archiveCodec === codec);
}

function planVideoTrack(codec: VideoCodec | "other"): VideoTrackPlan {
  return isArchiveVideoCodec(codec)
    ? { action: "copy" }
    : { action: "encode", codec: ARCHIVE_DEFAULT_VIDEO_CODEC };
}

function planAudioTrack(codec: AudioCodec | "other" | null): AudioTrackPlan {
  if (codec === null || ARCHIVE_AUDIO_CODECS.some((archiveCodec) => archiveCodec === codec)) {
    return { action: "copy" };
  }

  return { action: "encode-aac" };
}
