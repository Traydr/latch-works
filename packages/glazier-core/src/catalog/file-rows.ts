import path from "node:path";

import { z } from "zod";

import {
  type AudioState,
  FileFormatSchema,
  FileIdSchema,
  FileKindSchema,
  type FileRow,
  RootIdSchema,
} from "../contract.js";

/** A track whose loudest moment stays under this is silence (digital silence reads −91 dB). */
const SILENCE_THRESHOLD_DB = -60;

/** Bumped when the probe reads more, so old rows are probed again. */
export const PROBE_VERSION = 1;

export const FINGERPRINT_VERSION = 1;

export const LOUDNESS_VERSION = 1;

/**
 * The SQL twin of {@link audioStateOf}, for filtering in queries. A track the loudness pass could
 * not measure keeps its version and no level, and stays unmeasured.
 */
export const AUDIO_STATE_SQL = `CASE
  WHEN f.kind != 'video' OR f.probe_version = 0 THEN NULL
  WHEN COALESCE(f.audio_streams, 0) = 0 THEN 'none'
  WHEN f.loudness_version = 0 OR f.loudness_max_db IS NULL THEN 'unmeasured'
  WHEN f.loudness_max_db <= ${SILENCE_THRESHOLD_DB} THEN 'silent'
  ELSE 'sound' END`;

/** Every column a file row query selects, with its root's path. */
export const FILE_COLUMNS = `f.id, f.root_id, r.path AS root_path, f.rel_path, f.dir, f.name, f.ext,
  f.size, f.mtime_ms, f.ctime_ms, f.dev, f.ino, f.is_junk, f.kind, f.format, f.ext_mismatch,
  f.probe_version, f.probe_error, f.width, f.height, f.frames, f.has_alpha, f.duration_ms,
  f.video_codec, f.audio_codec, f.audio_streams, f.bitrate, f.sha256, f.fingerprint,
  f.loudness_version, f.loudness_max_db, f.optimize_not_smaller`;

export const FILES_FROM = "files f JOIN roots r ON r.id = f.root_id";

const NullableNumber = z.number().nullable();

const NullableString = z.string().nullable();

export const FileRecordSchema = z.object({
  id: FileIdSchema,
  root_id: RootIdSchema,
  root_path: z.string(),
  rel_path: z.string(),
  dir: z.string(),
  name: z.string(),
  ext: z.string(),
  size: z.number(),
  mtime_ms: z.number(),
  ctime_ms: z.number(),
  dev: z.string(),
  ino: z.string(),
  is_junk: z.number(),
  kind: FileKindSchema,
  format: FileFormatSchema.nullable(),
  ext_mismatch: z.number(),
  probe_version: z.number(),
  probe_error: NullableString,
  width: NullableNumber,
  height: NullableNumber,
  frames: NullableNumber,
  has_alpha: NullableNumber,
  duration_ms: NullableNumber,
  video_codec: NullableString,
  audio_codec: NullableString,
  audio_streams: NullableNumber,
  bitrate: NullableNumber,
  sha256: NullableString,
  fingerprint: NullableString,
  loudness_version: z.number(),
  loudness_max_db: NullableNumber,
  /** 1 once an optimize conversion of these bytes came out no smaller and was not kept. */
  optimize_not_smaller: z.number(),
});

/** A file as the catalog stores it, including the fields the contract keeps private. */
export type FileRecord = z.infer<typeof FileRecordSchema>;

/** Joins an archive path (forward slashes) onto its root with the platform's separator. */
export function toAbsolutePath(rootPath: string, relPath: string): string {
  return path.join(rootPath, ...relPath.split("/"));
}

export function audioStateOf(record: FileRecord): AudioState | null {
  if (record.kind !== "video" || record.probe_version === 0) {
    return null;
  }

  if ((record.audio_streams ?? 0) === 0) {
    return "none";
  }

  if (record.loudness_version === 0 || record.loudness_max_db === null) {
    return "unmeasured";
  }

  return record.loudness_max_db <= SILENCE_THRESHOLD_DB ? "silent" : "sound";
}

export function toFileRow(record: FileRecord): FileRow {
  return {
    id: record.id,
    rootId: record.root_id,
    relPath: record.rel_path,
    absPath: toAbsolutePath(record.root_path, record.rel_path),
    name: record.name,
    dir: record.dir,
    ext: record.ext,
    size: record.size,
    mtimeMs: record.mtime_ms,
    kind: record.kind,
    format: record.format,
    extensionMismatch: record.ext_mismatch === 1,
    width: record.width,
    height: record.height,
    frames: record.frames,
    durationMs: record.duration_ms,
    videoCodec: record.video_codec,
    audioCodec: record.audio_codec,
    audioState: audioStateOf(record),
    bitrate: record.bitrate,
    probeError: record.probe_error,
    sha256: record.sha256,
  };
}
