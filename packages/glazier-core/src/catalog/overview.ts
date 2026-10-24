import { z } from "zod";

import {
  FileFormatSchema,
  FileKindSchema,
  type Finding,
  type Overview,
  type RootId,
} from "../contract.js";
import type { CatalogDatabase, SqlParams } from "./database.js";
import { AUDIO_STATE_SQL } from "./file-rows.js";
import { SUPPORTED_EXTENSIONS_SQL } from "./files.js";

/** Pane View serves originals with these extensions by presigned URL instead of Shutter. */
const PRESIGNED_EXTENSIONS_SQL = "'mkv', 'bmp'";

const TotalsSchema = z.object({
  files: z.number(),
  bytes: z.number().nullable(),
  folders: z.number(),
});

const FormatRowSchema = z.object({
  format: FileFormatSchema.nullable(),
  kind: FileKindSchema,
  files: z.number(),
  bytes: z.number().nullable(),
});

const SoundRowSchema = z.object({ state: z.string().nullable(), files: z.number() });

const CountBytesSchema = z.object({ count: z.number(), bytes: z.number().nullable() });

const LastScanSchema = z.object({ last: z.number().nullable() });

/** Totals and findings for one root, or every root; duplicate and optimize totals come in. */
export function computeOverview(
  db: CatalogDatabase,
  rootId: RootId | null,
  derived: Pick<Overview, "duplicates" | "optimizable">,
): Overview {
  const params: SqlParams = {};
  let where = "WHERE 1 = 1";

  if (rootId !== null) {
    params.$root = rootId;
    where = "WHERE f.root_id = $root";
  }

  const totals = db.get(
    `SELECT COUNT(*) AS files, SUM(f.size) AS bytes, COUNT(DISTINCT f.root_id || '/' || f.dir) AS folders
      FROM files f ${where}`,
    TotalsSchema,
    params,
  );

  const byFormat = db.all(
    `SELECT f.format, f.kind, COUNT(*) AS files, SUM(f.size) AS bytes FROM files f ${where}
      GROUP BY f.format, f.kind ORDER BY bytes DESC`,
    FormatRowSchema,
    params,
  );

  const soundRows = db.all(
    `SELECT ${AUDIO_STATE_SQL} AS state, COUNT(*) AS files FROM files f ${where}
      AND f.kind = 'video' AND f.probe_version > 0 GROUP BY state`,
    SoundRowSchema,
    params,
  );

  const sound = { videos: 0, none: 0, silent: 0, sound: 0, unmeasured: 0 };

  for (const row of soundRows) {
    sound.videos += row.files;

    if (
      row.state === "none" ||
      row.state === "silent" ||
      row.state === "sound" ||
      row.state === "unmeasured"
    ) {
      sound[row.state] += row.files;
    }
  }

  const count = (condition: string): Omit<Finding, "kind"> => {
    const row = db.get(
      `SELECT COUNT(*) AS count, SUM(f.size) AS bytes FROM files f ${where} AND ${condition}`,
      CountBytesSchema,
      params,
    );

    return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
  };

  const emptyFolders = db.get(
    `SELECT COUNT(*) AS count, 0 AS bytes FROM empty_folders f ${where}`,
    CountBytesSchema,
    params,
  );

  const findings: Finding[] = [
    { kind: "extension-mismatch", ...count("f.ext_mismatch = 1") },
    { kind: "undecodable", ...count("f.probe_error IS NOT NULL") },
    { kind: "zero-byte", ...count("f.size = 0 AND f.is_junk = 0") },
    { kind: "junk", ...count("f.is_junk = 1") },
    { kind: "empty-folder", count: emptyFolders?.count ?? 0, bytes: 0 },
    {
      kind: "unsupported",
      ...count(`f.is_junk = 0 AND f.ext NOT IN (${SUPPORTED_EXTENSIONS_SQL})`),
    },
    { kind: "presigned-delivery", ...count(`f.ext IN (${PRESIGNED_EXTENSIONS_SQL})`) },
    {
      kind: "unconvertible-video",
      ...count("f.kind = 'video' AND f.format IN ('avi', 'flv', 'asf')"),
    },
  ];

  const lastScan = db.get(
    rootId === null
      ? "SELECT MAX(last_scan_at) AS last FROM roots"
      : "SELECT last_scan_at AS last FROM roots WHERE id = $root",
    LastScanSchema,
    params,
  );

  return {
    files: totals?.files ?? 0,
    bytes: totals?.bytes ?? 0,
    folders: totals?.folders ?? 0,
    lastScanAt: lastScan?.last ?? null,
    byFormat: byFormat.map((row) => ({
      format: row.format,
      kind: row.kind,
      files: row.files,
      bytes: row.bytes ?? 0,
    })),
    duplicates: derived.duplicates,
    optimizable: derived.optimizable,
    sound,
    findings,
  };
}
