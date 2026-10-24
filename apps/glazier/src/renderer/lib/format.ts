import type { FileFormat } from "@latch-works/glazier-core/contract";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1000) {
    return `${Math.round(bytes)} B`;
  }

  let value = bytes;
  let unit = 0;

  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

const countFormat = new Intl.NumberFormat();

export function formatCount(count: number): string {
  return countFormat.format(count);
}

/** "1 file", "2 files"; pass the plural when adding "s" is wrong. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "";
  }

  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDate(ms: number): string {
  return dateFormat.format(new Date(ms));
}

export function formatDateTime(ms: number): string {
  return dateTimeFormat.format(new Date(ms));
}

const dateTimeSecondsFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** The date and time to the second, for telling apart times that share a minute. */
export function formatDateTimeSeconds(ms: number): string {
  return dateTimeSecondsFormat.format(new Date(ms));
}

export function formatTime(ms: number): string {
  return timeFormat.format(new Date(ms));
}

/** "Today", "Yesterday", or the date, for grouping a log by day. */
export function formatDay(ms: number, now: number): string {
  const day = new Date(ms).toDateString();

  if (day === new Date(now).toDateString()) {
    return "Today";
  }

  if (day === new Date(now - 86_400_000).toDateString()) {
    return "Yesterday";
  }

  return formatDate(ms);
}

/** A path inside a root, without the root's own folders. */
export function relativeTo(rootPath: string | undefined, filePath: string): string {
  return rootPath && filePath.startsWith(rootPath)
    ? filePath.slice(rootPath.length).replace(/^[\\/]+/, "")
    : filePath;
}

export function formatRelative(ms: number | null, now = Date.now()): string {
  if (ms === null) {
    return "never";
  }

  const minutes = Math.round((now - ms) / 60_000);

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 24 ? `${hours} h ago` : formatDate(ms);
}

const FORMAT_LABELS = {
  jpeg: "JPEG",
  png: "PNG",
  gif: "GIF",
  webp: "WebP",
  bmp: "BMP",
  tiff: "TIFF",
  avif: "AVIF",
  heic: "HEIC",
  psd: "PSD",
  svg: "SVG",
  mp4: "MP4",
  mov: "MOV",
  matroska: "MKV",
  webm: "WebM",
  mpegts: "MPEG-TS",
  avi: "AVI",
  flv: "FLV",
  asf: "WMV",
  mp3: "MP3",
  m4a: "M4A",
  wav: "WAV",
  flac: "FLAC",
  ogg: "Ogg",
  pdf: "PDF",
  zip: "ZIP",
  rar: "RAR",
  "7z": "7z",
  empty: "Empty",
  unknown: "Other",
} as const satisfies Record<FileFormat, string>;

export function formatLabel(format: FileFormat | null): string {
  return format === null ? "Unread" : FORMAT_LABELS[format];
}

const CODEC_LABELS = new Map([
  ["h264", "H.264"],
  ["hevc", "HEVC"],
  ["av1", "AV1"],
  ["vp9", "VP9"],
  ["vp8", "VP8"],
  ["prores", "ProRes"],
  ["mpeg4", "MPEG-4"],
  ["aac", "AAC"],
  ["mp3", "MP3"],
  ["opus", "Opus"],
  ["vorbis", "Vorbis"],
  ["flac", "FLAC"],
]);

export function codecLabel(codec: string | null): string {
  return codec === null ? "" : (CODEC_LABELS.get(codec) ?? codec.toUpperCase());
}
