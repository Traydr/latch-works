import {
  detectMediaType,
  ImageExtensions,
  PdfExtensions,
  VideoExtensions,
} from "@latch-works/media-domain";
import { z } from "zod";

import type { FileId, FileKind, FilePage, FileQuery, RootId } from "../contract.js";
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
} as const satisfies Record<FileQuery["flags"][number], string>;

/** Escapes a search term for `LIKE … ESCAPE '\'`. */
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

function buildFileFilter(
  query: Omit<FileQuery, "offset" | "limit" | "sort" | "descending">,
): SqlFilter {
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

  for (const flag of query.flags) {
    clauses.push(FLAG_SQL[flag]);
  }

  if (query.dir !== null && query.dir !== "") {
    clauses.push("(f.dir = $dir OR f.dir LIKE $dir_prefix ESCAPE '\\')");
    params.$dir = query.dir;
    params.$dir_prefix = `${query.dir.replace(/[\\%_]/g, (character) => `\\${character}`)}/%`;
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
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

const DirSchema = z.object({ dir: z.string() });

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
