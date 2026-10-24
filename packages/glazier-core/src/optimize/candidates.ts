import {
  type ArchiveImageFormat,
  type ArchiveVideoPlan,
  type ArchiveVideoSource,
  type MediaAudioCodec as AudioCodec,
  planArchiveImage,
  planArchiveVideo,
  type MediaVideoCodec as VideoCodec,
  type VideoContainer,
} from "@latch-works/media-format";
import { z } from "zod";

import type { CatalogDatabase, SqlParams } from "../catalog/database.js";
import {
  FILE_COLUMNS,
  FILES_FROM,
  type FileRecord,
  FileRecordSchema,
} from "../catalog/file-rows.js";
import {
  type FileFormat,
  type FileId,
  FileIdSchema,
  type OptimizeCategory,
  type OptimizeSummary,
  type RootId,
} from "../contract.js";
import { Dismissals } from "../duplicates/dismissals.js";
import { exactGroupSql } from "../duplicates/queries.js";

/** A file the archive policy would change, and how. */
export type OptimizeCandidate =
  | {
      category: "still-to-avif" | "rename-avif" | "rename-mp4";
      record: FileRecord;
      targetName: string;
    }
  | {
      category: "animation-to-mp4";
      record: FileRecord;
      targetName: string;
      mimeType: "image/gif" | "image/webp" | "image/png";
    }
  | {
      category: "video-remux" | "video-convert";
      record: FileRecord;
      targetName: string;
      plan: Extract<ArchiveVideoPlan, { action: "convert-mp4" }>;
    };

const IMAGE_FORMATS = {
  png: "png",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  avif: "avif",
} as const satisfies Partial<Record<FileFormat, ArchiveImageFormat>>;

const VIDEO_CONTAINERS = {
  mp4: "mp4",
  mov: "mov",
  matroska: "matroska",
  webm: "webm",
  mpegts: "mpegts",
  avi: "avi",
  flv: "flv",
  asf: "asf",
} as const satisfies Partial<Record<FileFormat, VideoContainer>>;

/** ffprobe's codec names, mapped to Mediabunny's. */
const FFPROBE_VIDEO_CODECS = {
  h264: "avc",
  hevc: "hevc",
  av1: "av1",
  vp9: "vp9",
  vp8: "vp8",
  prores: "prores",
} as const satisfies Record<string, VideoCodec>;

const FFPROBE_AUDIO_CODECS = {
  aac: "aac",
  mp3: "mp3",
  opus: "opus",
  vorbis: "vorbis",
  flac: "flac",
  ac3: "ac3",
  eac3: "eac3",
  dts: "dts",
  pcm_s16le: "pcm-s16",
  pcm_s16be: "pcm-s16be",
  pcm_s24le: "pcm-s24",
  pcm_s32le: "pcm-s32",
  pcm_f32le: "pcm-f32",
  pcm_u8: "pcm-u8",
} as const satisfies Record<string, AudioCodec>;

function lookup<T extends Record<string, string>>(table: T, key: string | null): T[keyof T] | null {
  if (key === null || !Object.hasOwn(table, key)) {
    return null;
  }

  // SAFETY: `Object.hasOwn` just confirmed `key` is one of the table's own keys.
  return table[key as keyof T];
}

const MIME_TYPES = { gif: "image/gif", webp: "image/webp", png: "image/png" } as const;

export function videoSourceOf(record: FileRecord): ArchiveVideoSource | null {
  const container = lookup(VIDEO_CONTAINERS, record.format);

  if (container === null) {
    return null;
  }

  return {
    fileName: record.name,
    container,
    videoCodec:
      record.video_codec === null
        ? null
        : (lookup(FFPROBE_VIDEO_CODECS, record.video_codec) ?? "other"),
    audioCodec:
      (record.audio_streams ?? 0) === 0 || record.audio_codec === null
        ? null
        : (lookup(FFPROBE_AUDIO_CODECS, record.audio_codec) ?? "other"),
  };
}

export interface CandidateScan {
  candidates: OptimizeCandidate[];
  skipped: Map<string, number>;
}

function relPathBeside(record: FileRecord, name: string): string {
  return record.dir ? `${record.dir}/${name}` : name;
}

/** Why a file the policy would change is left out of the Convert step. */
const SKIP_DUPLICATE = "Identical copies (resolve duplicates first)";

const SKIP_NOT_SMALLER = "Already as small as they get";

/**
 * Every file in an open set of identical copies. Converting one of them, even the keeper, turns
 * the set from identical copies into similar versions that need a closer look, so the whole set
 * waits until its duplicates are resolved or dismissed.
 */
function openDuplicateCopies(db: CatalogDatabase, rootId: RootId): Set<FileId> {
  const params: SqlParams = {};

  const members = db.all(
    `SELECT f.id, f.sha256 FROM files f
      WHERE f.sha256 IN (${exactGroupSql(rootId, params)})
        AND f.root_id = $root AND f.is_junk = 0 AND f.size > 0`,
    z.object({ id: FileIdSchema, sha256: z.string() }),
    params,
  );

  const groups = new Map<string, FileId[]>();

  for (const member of members) {
    groups.set(member.sha256, [...(groups.get(member.sha256) ?? []), member.id]);
  }

  const dismissals = Dismissals.load(db);
  const open = new Set<FileId>();

  for (const ids of groups.values()) {
    if (dismissals.covering(ids) === null) {
      for (const id of ids) {
        open.add(id);
      }
    }
  }

  return open;
}

/**
 * Every file under a root the archive policy would convert or rename. A conversion whose target
 * name is already taken is skipped, never overwritten; the two files are usually the same picture
 * and the duplicates view resolves them. Identical copies wait for that too, and a file an earlier
 * conversion could not shrink is left as it is.
 */
export function findOptimizeCandidates(db: CatalogDatabase, rootId: RootId): CandidateScan {
  const params: SqlParams = { $root: rootId };

  const records = db.all(
    `SELECT ${FILE_COLUMNS} FROM ${FILES_FROM}
      WHERE f.root_id = $root AND f.is_junk = 0 AND f.size > 0 AND f.kind IN ('image', 'video')
        AND f.probe_version > 0`,
    FileRecordSchema,
    params,
  );

  const taken = new Set(
    db
      .all(
        "SELECT rel_path FROM files WHERE root_id = $root",
        z.object({ rel_path: z.string() }),
        params,
      )
      .map((row) => row.rel_path.toLowerCase()),
  );

  const duplicates = openDuplicateCopies(db, rootId);
  const candidates: OptimizeCandidate[] = [];
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  for (const record of records) {
    if (record.probe_error !== null) {
      skip("Won't decode");

      continue;
    }

    const candidate =
      record.kind === "image" ? imageCandidate(record, skip) : videoCandidate(record, skip);

    if (candidate === null) {
      continue;
    }

    if (duplicates.has(record.id)) {
      skip(SKIP_DUPLICATE);

      continue;
    }

    if (record.optimize_not_smaller === 1) {
      skip(SKIP_NOT_SMALLER);

      continue;
    }

    const targetRel = relPathBeside(record, candidate.targetName).toLowerCase();

    if (targetRel !== record.rel_path.toLowerCase() && taken.has(targetRel)) {
      skip("A file with the target name already exists");

      continue;
    }

    candidates.push(candidate);
  }

  return { candidates, skipped };
}

/** Records a root's convertible files for file queries on this connection to filter by. */
export function recordConvertible(
  db: CatalogDatabase,
  rootId: RootId,
  candidates: readonly OptimizeCandidate[],
): void {
  db.transaction(() => {
    db.run("DELETE FROM temp.convertible_files WHERE root_id = $root", { $root: rootId });

    for (const candidate of candidates) {
      db.run("INSERT OR IGNORE INTO temp.convertible_files (id, root_id) VALUES ($id, $root)", {
        $id: candidate.record.id,
        $root: rootId,
      });
    }
  });
}

/** Forgets every recorded convertible file, when the catalog changed under them. */
export function forgetConvertible(db: CatalogDatabase): void {
  db.run("DELETE FROM temp.convertible_files");
}

function imageCandidate(
  record: FileRecord,
  skip: (reason: string) => void,
): OptimizeCandidate | null {
  const format = lookup(IMAGE_FORMATS, record.format);

  if (format === null) {
    if (record.format === "tiff" || record.format === "heic") {
      skip(`${record.format.toUpperCase()} stills are left as they are`);
    }

    return null;
  }

  const plan = planArchiveImage({ fileName: record.name, format, frameCount: record.frames ?? 1 });

  if (plan === null) {
    return null;
  }

  switch (plan.action) {
    case "convert-avif":
      return { category: "still-to-avif", record, targetName: plan.fileName };
    case "rename-avif":
      return { category: "rename-avif", record, targetName: plan.fileName };
    case "convert-mp4": {
      const mimeType =
        format === "gif" || format === "webp" || format === "png" ? MIME_TYPES[format] : null;

      return mimeType === null
        ? null
        : { category: "animation-to-mp4", record, targetName: plan.fileName, mimeType };
    }

    case "rename-mp4":
      return null;
    default: {
      const _exhaustive: never = plan.action;

      return _exhaustive;
    }
  }
}

function videoCandidate(
  record: FileRecord,
  skip: (reason: string) => void,
): OptimizeCandidate | null {
  const source = videoSourceOf(record);

  if (source === null) {
    return null;
  }

  const plan = planArchiveVideo(source);

  if (plan === null) {
    return null;
  }

  switch (plan.action) {
    case "rename-mp4":
      return { category: "rename-mp4", record, targetName: plan.fileName };
    case "convert-mp4":
      return {
        category:
          plan.video.action === "copy" && plan.audio.action === "copy"
            ? "video-remux"
            : "video-convert",
        record,
        targetName: plan.fileName,
        plan,
      };
    case "unsupported":
      skip(plan.reason);

      return null;
    default: {
      const _exhaustive: never = plan;

      return _exhaustive;
    }
  }
}

const CATEGORY_ORDER = [
  "still-to-avif",
  "animation-to-mp4",
  "video-remux",
  "video-convert",
  "rename-avif",
  "rename-mp4",
] as const satisfies readonly OptimizeCategory[];

export function summarizeCandidates(scan: CandidateScan): OptimizeSummary {
  return {
    categories: CATEGORY_ORDER.map((category) => {
      let files = 0;
      let bytes = 0;

      for (const candidate of scan.candidates) {
        if (candidate.category === category) {
          files += 1;
          bytes += candidate.record.size;
        }
      }

      return { category, files, bytes };
    }),
    skipped: [...scan.skipped].map(([reason, files]) => ({ reason, files })),
  };
}
