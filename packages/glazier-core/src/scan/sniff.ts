import { open } from "node:fs/promises";

import type { FileFormat, FileKind } from "../contract.js";

/** Enough bytes for every signature below, including MPEG-TS's second sync byte at 188. */
const SNIFF_BYTES = 512;

/** Reads a file's first bytes and names its format. A file that cannot be read is `unknown`. */
export async function sniffFile(filePath: string, size: number): Promise<FileFormat> {
  if (size === 0) {
    return "empty";
  }

  const handle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    return sniffBytes(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Names the format a file's leading bytes identify. */
export function sniffBytes(bytes: Buffer): FileFormat {
  if (bytes.length === 0) {
    return "empty";
  }

  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";

  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";

  if (ascii(0, 4) === "RIFF") {
    const riffType = ascii(8, 12);

    if (riffType === "WEBP") return "webp";

    if (riffType === "AVI ") return "avi";

    if (riffType === "WAVE") return "wav";

    return "unknown";
  }

  if (ascii(4, 8) === "ftyp") {
    return sniffIsoBrand(bytes);
  }

  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(0, bytes.length).includes("webm") ? "webm" : "matroska";
  }

  if (bytes[0] === 0x47 && bytes.length > 188 && bytes[188] === 0x47) return "mpegts";

  if (ascii(0, 2) === "BM") return "bmp";

  if (ascii(0, 4) === "II*\u0000" || ascii(0, 4) === "MM\u0000*") return "tiff";

  if (ascii(0, 4) === "8BPS") return "psd";

  if (ascii(0, 4) === "%PDF") return "pdf";

  if (ascii(0, 3) === "FLV") return "flv";

  if (startsWith(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return "asf";

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";

  if (ascii(0, 4) === "Rar!") return "rar";

  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";

  if (ascii(0, 4) === "fLaC") return "flac";

  if (ascii(0, 4) === "OggS") return "ogg";

  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
    return "mp3";
  }

  const leadingText = ascii(0, Math.min(bytes.length, 256)).trimStart().toLowerCase();

  if (
    leadingText.startsWith("<svg") ||
    (leadingText.startsWith("<?xml") && leadingText.includes("<svg"))
  ) {
    return "svg";
  }

  return "unknown";
}

/** ISO base media files name their flavour in the `ftyp` box: major brand, then compatibles. */
function sniffIsoBrand(bytes: Buffer): FileFormat {
  const boxSize = bytes.readUInt32BE(0);
  const end = Math.min(bytes.length, Math.max(16, boxSize));
  const brands: string[] = [];

  for (let offset = 8; offset + 4 <= end; offset += 4) {
    // Bytes 12–16 are the minor version, not a brand.
    if (offset !== 12) {
      brands.push(bytes.subarray(offset, offset + 4).toString("latin1"));
    }
  }

  const major = brands[0] ?? "";

  if (major === "avif" || major === "avis") return "avif";

  if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(major)) return "heic";

  if (major === "mif1" || major === "msf1") {
    return brands.includes("avif") || brands.includes("avis") ? "avif" : "heic";
  }

  if (major === "qt  ") return "mov";

  if (major === "M4A " || major === "M4B ") return "m4a";

  return "mp4";
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

const FORMAT_KINDS = {
  png: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  tiff: "image",
  avif: "image",
  heic: "image",
  psd: "other",
  svg: "other",
  mp4: "video",
  mov: "video",
  matroska: "video",
  webm: "video",
  mpegts: "video",
  avi: "video",
  flv: "video",
  asf: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  pdf: "pdf",
  zip: "other",
  rar: "other",
  "7z": "other",
  empty: "other",
  unknown: "other",
} as const satisfies Record<FileFormat, FileKind>;

export function kindForFormat(format: FileFormat): FileKind {
  return FORMAT_KINDS[format];
}

/** The extensions each format is correctly named with; an empty list accepts any extension. */
const FORMAT_EXTENSIONS = {
  png: ["png", "apng"],
  jpeg: ["jpg", "jpeg", "jpe", "jfif"],
  gif: ["gif"],
  webp: ["webp"],
  bmp: ["bmp", "dib"],
  tiff: ["tif", "tiff", "dng", "nef", "cr2", "arw"],
  avif: ["avif"],
  heic: ["heic", "heif", "hif"],
  psd: ["psd", "psb"],
  svg: ["svg"],
  mp4: ["mp4", "m4v", "3gp", "3g2", "f4v"],
  mov: ["mov", "qt"],
  matroska: ["mkv", "mka", "mk3d"],
  webm: ["webm"],
  mpegts: ["ts", "mts", "m2ts", "tsv"],
  avi: ["avi"],
  flv: ["flv"],
  asf: ["wmv", "wma", "asf"],
  mp3: ["mp3"],
  m4a: ["m4a", "m4b", "aac"],
  wav: ["wav"],
  flac: ["flac"],
  ogg: ["ogg", "oga", "ogv", "opus"],
  pdf: ["pdf"],
  zip: [
    "zip",
    "cbz",
    "epub",
    "docx",
    "xlsx",
    "pptx",
    "jar",
    "apk",
    "ipa",
    "pages",
    "key",
    "numbers",
  ],
  rar: ["rar", "cbr"],
  "7z": ["7z", "cb7"],
  empty: [],
  unknown: [],
} as const satisfies Record<FileFormat, readonly string[]>;

/**
 * Archive formats other file types are built on: zip bytes say little about what a file is for
 * (a game's `.zipmod`, an add-on, a document), and a `.r00` or `.7z.001` is one part of a split
 * archive. Such a file's extension is wrong only when it names another format here.
 */
const CONTAINER_FORMATS = new Set<FileFormat>(["zip", "rar", "7z"]);

const KNOWN_EXTENSIONS = new Set<string>(Object.values(FORMAT_EXTENSIONS).flat());

/** True when the bytes are a known format the file's extension does not name. */
export function isExtensionMismatch(format: FileFormat, ext: string): boolean {
  const accepted: readonly string[] = FORMAT_EXTENSIONS[format];
  const extension = ext.toLowerCase();

  if (accepted.length === 0 || accepted.includes(extension)) {
    return false;
  }

  return !CONTAINER_FORMATS.has(format) || KNOWN_EXTENSIONS.has(extension);
}

/** The extension a file of this format is renamed to when its own is wrong. */
export function preferredExtension(format: FileFormat): string | null {
  const accepted: readonly string[] = FORMAT_EXTENSIONS[format];

  return accepted[0] ?? null;
}
