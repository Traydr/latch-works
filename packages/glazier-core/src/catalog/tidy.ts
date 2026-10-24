import { z } from "zod";

import type { Finding, FindingKind, RootId, Tidy } from "../contract.js";
import { FINGERPRINTABLE_SQL } from "../passes/fingerprint-pass.js";
import type { CatalogDatabase } from "./database.js";
import { AUDIO_STATE_SQL, LOUDNESS_VERSION } from "./file-rows.js";
import { SUPPORTED_EXTENSIONS_SQL } from "./files.js";

/** Pane View serves originals with these extensions by presigned URL instead of Shutter. */
const PRESIGNED_EXTENSIONS_SQL = "'mkv', 'bmp'";

/** What each finding counts, as a condition on `files f`. */
const FINDING_SQL = {
  undecodable: "f.probe_error IS NOT NULL",
  "zero-byte": "f.size = 0 AND f.is_junk = 0",
  unsupported: `f.is_junk = 0 AND f.ext NOT IN (${SUPPORTED_EXTENSIONS_SQL})`,
  "presigned-delivery": `f.ext IN (${PRESIGNED_EXTENSIONS_SQL})`,
  "unconvertible-video": "f.kind = 'video' AND f.format IN ('avi', 'flv', 'asf')",
} as const satisfies Record<FindingKind, string>;

const FINDING_KINDS = [
  "undecodable",
  "zero-byte",
  "unsupported",
  "presigned-delivery",
  "unconvertible-video",
] as const satisfies readonly FindingKind[];

const CountsSchema = z.record(z.string(), z.number().nullable());

const LastScanSchema = z.object({ last: z.number().nullable() });

/** The parts of a root's Tidy list the catalog answers directly. */
export type CatalogTidy = Pick<
  Tidy,
  "files" | "bytes" | "lastScanAt" | "silentTracks" | "attention" | "analysis"
> & { junk: number; emptyFolders: number };

/**
 * Totals, silent soundtracks, junk, empty folders, the findings that need a human look (only
 * those with files) and how far the background analysis has come, in two queries.
 */
export function catalogTidy(db: CatalogDatabase, rootId: RootId): CatalogTidy {
  const findingSums = FINDING_KINDS.map(
    (kind, index) =>
      `SUM(CASE WHEN ${FINDING_SQL[kind]} THEN 1 ELSE 0 END) AS finding${index},
      SUM(CASE WHEN ${FINDING_SQL[kind]} THEN f.size ELSE 0 END) AS finding_bytes${index}`,
  );

  const row =
    db.get(
      `SELECT COUNT(*) AS files, SUM(f.size) AS bytes,
        SUM(f.is_junk = 1) AS junk,
        SUM((${AUDIO_STATE_SQL}) = 'silent') AS silent,
        SUM(CASE WHEN (${AUDIO_STATE_SQL}) = 'silent' THEN f.size ELSE 0 END) AS silent_bytes,
        SUM(f.kind = 'video' AND f.probe_version > 0 AND COALESCE(f.audio_streams, 0) > 0)
          AS measurable,
        SUM(f.kind = 'video' AND f.probe_version > 0 AND COALESCE(f.audio_streams, 0) > 0
          AND f.loudness_version >= $loudness) AS measured,
        SUM(${FINGERPRINTABLE_SQL}) AS fingerprintable,
        SUM((${FINGERPRINTABLE_SQL})
          AND (f.fingerprint IS NOT NULL OR f.fingerprint_error IS NOT NULL)) AS fingerprinted,
        ${findingSums.join(",\n        ")},
        (SELECT COUNT(*) FROM empty_folders e WHERE e.root_id = $root) AS empty_folders
        FROM files f WHERE f.root_id = $root`,
      CountsSchema,
      { $root: rootId, $loudness: LOUDNESS_VERSION },
    ) ?? {};

  const count = (column: string) => row[column] ?? 0;

  const attention: Finding[] = FINDING_KINDS.flatMap((kind, index) => {
    const files = count(`finding${index}`);

    return files > 0 ? [{ kind, count: files, bytes: count(`finding_bytes${index}`) }] : [];
  });

  const lastScan = db.get(
    "SELECT last_scan_at AS last FROM roots WHERE id = $root",
    LastScanSchema,
    {
      $root: rootId,
    },
  );

  return {
    files: count("files"),
    bytes: count("bytes"),
    lastScanAt: lastScan?.last ?? null,
    silentTracks: { files: count("silent"), bytes: count("silent_bytes") },
    attention,
    analysis: {
      fingerprinted: count("fingerprinted"),
      fingerprintable: count("fingerprintable"),
      soundMeasured: count("measured"),
      soundMeasurable: count("measurable"),
    },
    junk: count("junk"),
    emptyFolders: count("empty_folders"),
  };
}
