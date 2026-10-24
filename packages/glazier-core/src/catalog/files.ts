import {
  detectMediaType,
  ImageExtensions,
  PdfExtensions,
  VideoExtensions,
} from "@latch-works/media-domain";
import { z } from "zod";

import {
  AudioStateSchema,
  type FileFacets,
  type FileFilter,
  type FileFlag,
  FileFlagSchema,
  FileFormatSchema,
  type FileId,
  FileIdSchema,
  type FileKind,
  FileKindSchema,
  type FilePage,
  type FileQuery,
  MAX_BULK_FILES,
  type RootId,
  RootIdSchema,
  type SelectionSummary,
} from "../contract.js";
import type { WalkedFile } from "../scan/walk.js";
import type { CatalogDatabase, SqlParams } from "./database.js";
import {
  AUDIO_STATE_SQL,
  FILE_COLUMNS,
  FILES_FROM,
  type FileRecord,
  FileRecordSchema,
  toFileRow,
} from "./file-rows.js";

/**
 * Columns derived from a file's bytes, and the value each returns to when the bytes change.
 * The walk's upsert resets them all whenever size, mtime or ctime moved, so nothing stale (a
 * hash, a probe, a fingerprint) outlives the content it describes.
 */
const DERIVED_COLUMN_RESETS = {
  format: "NULL",
  ext_mismatch: "0",
  probe_version: "0",
  probe_error: "NULL",
  width: "NULL",
  height: "NULL",
  frames: "NULL",
  has_alpha: "NULL",
  duration_ms: "NULL",
  video_codec: "NULL",
  audio_codec: "NULL",
  audio_streams: "NULL",
  bitrate: "NULL",
  head_hash: "NULL",
  sha256: "NULL",
  fingerprint_version: "0",
  fingerprint: "NULL",
  fingerprint_error: "NULL",
  loudness_version: "0",
  loudness_max_db: "NULL",
  optimize_not_smaller: "0",
} as const;

const CHANGED = `(files.size != excluded.size
  OR CAST(files.mtime_ms AS INTEGER) != CAST(excluded.mtime_ms AS INTEGER)
  OR CAST(files.ctime_ms AS INTEGER) != CAST(excluded.ctime_ms AS INTEGER))`;

const UPSERT_WALKED_SQL = `INSERT INTO files
  (root_id, rel_path, dir, name, ext, size, mtime_ms, ctime_ms, dev, ino, is_junk, last_seen_scan, kind)
  VALUES ($root_id, $rel_path, $dir, $name, $ext, $size, $mtime_ms, $ctime_ms, $dev, $ino, $is_junk,
    $scan, $kind)
  ON CONFLICT (root_id, rel_path) DO UPDATE SET
    dir = excluded.dir,
    name = excluded.name,
    ext = excluded.ext,
    dev = excluded.dev,
    ino = excluded.ino,
    is_junk = excluded.is_junk,
    last_seen_scan = excluded.last_seen_scan,
    ${Object.entries(DERIVED_COLUMN_RESETS)
      .map(
        ([column, reset]) =>
          `${column} = CASE WHEN ${CHANGED} THEN ${reset} ELSE files.${column} END`,
      )
      .join(",\n    ")},
    kind = CASE WHEN ${CHANGED} OR files.format IS NULL THEN excluded.kind ELSE files.kind END,
    size = excluded.size,
    mtime_ms = excluded.mtime_ms,
    ctime_ms = excluded.ctime_ms`;

/** What a file is before its bytes are read: its extension's media type, or junk. */
export function initialKind(name: string, junk: boolean): FileKind {
  if (junk) {
    return "junk";
  }

  const mediaType = detectMediaType(name);

  switch (mediaType) {
    case "image":
    case "gif":
      return "image";
    case "video":
      return "video";
    case "pdf":
      return "pdf";
    case "unknown":
      return "other";
    default: {
      const _exhaustive: never = mediaType;

      return _exhaustive;
    }
  }
}

export function upsertWalkedFiles(
  db: CatalogDatabase,
  target: { rootId: RootId; scanId: number },
  files: readonly WalkedFile[],
): void {
  db.transaction(() => {
    for (const file of files) {
      db.run(UPSERT_WALKED_SQL, {
        $root_id: target.rootId,
        $rel_path: file.relPath,
        $dir: file.dir,
        $name: file.name,
        $ext: file.ext,
        $size: file.size,
        $mtime_ms: file.mtimeMs,
        $ctime_ms: file.ctimeMs,
        $dev: file.dev,
        $ino: file.ino,
        $is_junk: file.junk ? 1 : 0,
        $scan: target.scanId,
        $kind: initialKind(file.name, file.junk),
      });
    }
  });
}

/** Drops files the latest walk of a root did not see: they were deleted or moved outside Glazier. */
export function deleteUnseenFiles(db: CatalogDatabase, rootId: RootId, scanId: number): number {
  return db.run("DELETE FROM files WHERE root_id = $root AND last_seen_scan != $scan", {
    $root: rootId,
    $scan: scanId,
  }).changes;
}

export function replaceEmptyFolders(
  db: CatalogDatabase,
  rootId: RootId,
  folders: readonly string[],
): void {
  db.transaction(() => {
    db.run("DELETE FROM empty_folders WHERE root_id = $root", { $root: rootId });

    for (const folder of folders) {
      db.run("INSERT INTO empty_folders (root_id, rel_path) VALUES ($root, $path)", {
        $root: rootId,
        $path: folder,
      });
    }
  });
}

export function getFileRecords(db: CatalogDatabase, fileIds: readonly FileId[]): FileRecord[] {
  const records: FileRecord[] = [];

  for (let start = 0; start < fileIds.length; start += 500) {
    const slice = fileIds.slice(start, start + 500);
    const params: SqlParams = {};

    const names = slice.map((id, index) => {
      params[`$id${index}`] = id;

      return `$id${index}`;
    });

    records.push(
      ...db.all(
        `SELECT ${FILE_COLUMNS} FROM ${FILES_FROM} WHERE f.id IN (${names.join(", ")})`,
        FileRecordSchema,
        params,
      ),
    );
  }

  return records;
}

/** Extensions some Latch Works app shows; everything else is unsupported. */
export const SUPPORTED_EXTENSIONS_SQL = [...ImageExtensions, ...VideoExtensions, ...PdfExtensions]
  .map((extension) => `'${extension}'`)
  .join(", ");

const SORT_SQL = {
  name: "f.name COLLATE NOCASE",
  path: "f.rel_path COLLATE NOCASE",
  size: "f.size",
  mtime: "f.mtime_ms",
  kind: "f.kind, f.format",
  duration: "f.duration_ms",
} as const satisfies Record<FileQuery["sort"], string>;

const FLAG_SQL = {
  "extension-mismatch": "f.ext_mismatch = 1",
  undecodable: "f.probe_error IS NOT NULL",
  "zero-byte": "f.size = 0 AND f.is_junk = 0",
  junk: "f.is_junk = 1",
  animated: "COALESCE(f.frames, 1) > 1",
  duplicate: `f.sha256 IN (SELECT sha256 FROM files WHERE sha256 IS NOT NULL
    GROUP BY sha256 HAVING COUNT(*) > 1)`,
  unsupported: `f.is_junk = 0 AND f.ext NOT IN (${SUPPORTED_EXTENSIONS_SQL})`,
  // Filled per root from the engine's candidate cache; see `recordConvertible`.
  convertible: "f.id IN (SELECT id FROM temp.convertible_files)",
} as const satisfies Record<FileFlag, string>;

/** Escapes a search term for `LIKE … ESCAPE '\\'`. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function inList(params: SqlParams, prefix: string, values: readonly string[]): string {
  return values
    .map((value, index) => {
      params[`$${prefix}${index}`] = value;

      return `$${prefix}${index}`;
    })
    .join(", ");
}

/** A WHERE clause over `files f` and the parameters it binds. */
interface SqlFilter {
  where: string;
  params: SqlParams;
}

/**
 * Values within one list match any of them (a file is a PNG or a JPEG); the lists, the search and
 * the folder all have to match together.
 */
function buildFileFilter(query: FileFilter): SqlFilter {
  const clauses: string[] = [];
  const params: SqlParams = {};

  if (query.rootId !== null) {
    clauses.push("f.root_id = $root");
    params.$root = query.rootId;
  }

  if (query.search.trim()) {
    clauses.push("f.rel_path LIKE $search ESCAPE '\\'");
    params.$search = likePattern(query.search.trim());
  }

  if (query.kinds.length > 0) {
    clauses.push(`f.kind IN (${inList(params, "kind", query.kinds)})`);
  }

  if (query.formats.length > 0) {
    clauses.push(`f.format IN (${inList(params, "format", query.formats)})`);
  }

  if (query.audioStates.length > 0) {
    clauses.push(`(${AUDIO_STATE_SQL}) IN (${inList(params, "audio", query.audioStates)})`);
  }

  if (query.flags.length > 0) {
    clauses.push(`(${query.flags.map((flag) => `(${FLAG_SQL[flag]})`).join(" OR ")})`);
  }

  if (query.dir !== null && query.dir !== "") {
    clauses.push("(f.dir = $dir OR f.dir LIKE $dir_prefix ESCAPE '\\')");
    params.$dir = query.dir;
    params.$dir_prefix = `${query.dir.replace(/[\\%_]/g, (character) => `\\${character}`)}/%`;
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** True when answering the filter needs the convertible files recorded first. */
export function filterNeedsConvertible(filter: FileFilter): boolean {
  return filter.flags.includes("convertible");
}

const CountSchema = z.object({ total: z.number(), bytes: z.number().nullable() });

export function listFiles(db: CatalogDatabase, query: FileQuery): FilePage {
  const { where, params } = buildFileFilter(query);

  const counts = db.get(
    `SELECT COUNT(*) AS total, SUM(f.size) AS bytes FROM ${FILES_FROM} ${where}`,
    CountSchema,
    params,
  );

  const direction = query.descending ? "DESC" : "ASC";

  const rows = db.all(
    `SELECT ${FILE_COLUMNS} FROM ${FILES_FROM} ${where}
      ORDER BY ${SORT_SQL[query.sort]} ${direction}, f.id ${direction}
      LIMIT $limit OFFSET $offset`,
    FileRecordSchema,
    { ...params, $limit: query.limit, $offset: query.offset },
  );

  return {
    total: counts?.total ?? 0,
    totalBytes: counts?.bytes ?? 0,
    rows: rows.map(toFileRow),
  };
}

const IdRowSchema = z.object({ id: FileIdSchema });

/** File ids for a bulk action, and whether there were more than it can take. */
export interface FileIdList {
  ids: FileId[];
  truncated: boolean;
}

/** Every matching file's id in path order, up to {@link MAX_BULK_FILES}. */
export function listFileIds(db: CatalogDatabase, filter: FileFilter): FileIdList {
  const { where, params } = buildFileFilter(filter);

  const rows = db.all(
    `SELECT f.id FROM ${FILES_FROM} ${where} ORDER BY ${SORT_SQL.path}, f.id LIMIT $limit`,
    IdRowSchema,
    { ...params, $limit: MAX_BULK_FILES + 1 },
  );

  return {
    ids: rows.slice(0, MAX_BULK_FILES).map((row) => row.id),
    truncated: rows.length > MAX_BULK_FILES,
  };
}

const FacetRowSchema = z.object({
  value: z.string().nullable(),
  files: z.number(),
  bytes: z.number(),
});

/**
 * Counts and bytes per kind, format, audio state and flag. Each list is counted under every
 * filter but its own, so choosing a value shows what it would add.
 */
export function fileFacets(db: CatalogDatabase, filter: FileFilter): FileFacets {
  const grouped = (others: FileFilter, valueSql: string) => {
    const { where, params } = buildFileFilter(others);

    return db.all(
      `SELECT * FROM (SELECT ${valueSql} AS value, COUNT(*) AS files, COALESCE(SUM(f.size), 0) AS bytes
        FROM ${FILES_FROM} ${where} GROUP BY value) ORDER BY files DESC, value`,
      FacetRowSchema,
      params,
    );
  };

  const kinds = grouped({ ...filter, kinds: [] }, "f.kind").flatMap((row) => {
    const value = FileKindSchema.safeParse(row.value);

    return value.success ? [{ value: value.data, files: row.files, bytes: row.bytes }] : [];
  });

  const formats = grouped({ ...filter, formats: [] }, "f.format").flatMap((row) => {
    const value = FileFormatSchema.nullable().safeParse(row.value);

    return value.success ? [{ value: value.data, files: row.files, bytes: row.bytes }] : [];
  });

  const audioStates = grouped({ ...filter, audioStates: [] }, `(${AUDIO_STATE_SQL})`).flatMap(
    (row) => {
      const value = AudioStateSchema.safeParse(row.value);

      return value.success ? [{ value: value.data, files: row.files, bytes: row.bytes }] : [];
    },
  );

  const { where, params } = buildFileFilter({ ...filter, flags: [] });

  const sums = FileFlagSchema.options.map(
    (flag, index) =>
      `SUM(CASE WHEN ${FLAG_SQL[flag]} THEN 1 ELSE 0 END) AS files${index},
      SUM(CASE WHEN ${FLAG_SQL[flag]} THEN f.size ELSE 0 END) AS bytes${index}`,
  );

  const totals = db.get(
    `SELECT ${sums.join(", ")} FROM ${FILES_FROM} ${where}`,
    z.record(z.string(), z.number().nullable()),
    params,
  );

  const flags = FileFlagSchema.options.flatMap((flag, index) => {
    const files = totals?.[`files${index}`] ?? 0;

    return files > 0 ? [{ value: flag, files, bytes: totals?.[`bytes${index}`] ?? 0 }] : [];
  });

  return { kinds, formats, audioStates, flags };
}

const SelectionRowSchema = z.object({
  files: z.number(),
  bytes: z.number().nullable(),
  convertible: z.number().nullable(),
  convertible_bytes: z.number().nullable(),
  videos: z.number().nullable(),
  with_audio: z.number().nullable(),
  mismatches: z.number().nullable(),
});

/** Binds a list of ids as one JSON parameter, for `IN (SELECT value FROM json_each($ids))`. */
function idsParam(fileIds: readonly FileId[]): string {
  return JSON.stringify(fileIds);
}

/** The roots the given files belong to. */
export function rootsOfFiles(db: CatalogDatabase, fileIds: readonly FileId[]): RootId[] {
  return db
    .all(
      "SELECT DISTINCT root_id FROM files WHERE id IN (SELECT value FROM json_each($ids))",
      z.object({ root_id: RootIdSchema }),
      { $ids: idsParam(fileIds) },
    )
    .map((row) => row.root_id);
}

/** What a selection holds. Convertible counts need the selection's roots recorded first. */
export function selectionSummary(
  db: CatalogDatabase,
  fileIds: readonly FileId[],
): SelectionSummary {
  const row = db.get(
    `SELECT COUNT(*) AS files, SUM(f.size) AS bytes,
      SUM(c.id IS NOT NULL) AS convertible,
      SUM(CASE WHEN c.id IS NOT NULL THEN f.size ELSE 0 END) AS convertible_bytes,
      SUM(f.kind = 'video') AS videos,
      SUM(f.kind = 'video' AND COALESCE(f.audio_streams, 0) > 0) AS with_audio,
      SUM(f.ext_mismatch = 1) AS mismatches
      FROM files f LEFT JOIN temp.convertible_files c ON c.id = f.id
      WHERE f.id IN (SELECT value FROM json_each($ids))`,
    SelectionRowSchema,
    { $ids: idsParam(fileIds) },
  );

  return {
    files: row?.files ?? 0,
    bytes: row?.bytes ?? 0,
    convertible: { files: row?.convertible ?? 0, bytes: row?.convertible_bytes ?? 0 },
    videos: row?.videos ?? 0,
    withAudio: row?.with_audio ?? 0,
    extensionMismatches: row?.mismatches ?? 0,
  };
}

const DirSchema = z.object({ dir: z.string() });

const RelPathSchema = z.object({ rel_path: z.string() });

/** The folders the last scan found empty, relative to the root, in path order. */
export function listEmptyFolders(db: CatalogDatabase, rootId: RootId): string[] {
  return db
    .all(
      "SELECT rel_path FROM empty_folders WHERE root_id = $root ORDER BY rel_path COLLATE NOCASE",
      RelPathSchema,
      { $root: rootId },
    )
    .map(({ rel_path }) => rel_path);
}

/** Every folder that holds a file, relative to the root, in path order. */
export function listFolders(db: CatalogDatabase, rootId: RootId): string[] {
  const dirs = db.all(
    "SELECT DISTINCT dir FROM files WHERE root_id = $root ORDER BY dir COLLATE NOCASE",
    DirSchema,
    { $root: rootId },
  );

  const folders = new Set<string>();

  for (const { dir } of dirs) {
    const segments = dir.split("/").filter(Boolean);

    for (let depth = 1; depth <= segments.length; depth += 1) {
      folders.add(segments.slice(0, depth).join("/"));
    }
  }

  return [...folders].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}
