import { z } from "zod";

import type { CatalogDatabase, SqlParams } from "../catalog/database.js";
import { audioStateOf, type FileRecord } from "../catalog/file-rows.js";
import type { RootId, Settings, SimilarityLevel } from "../contract.js";
import { FileIdSchema } from "../contract.js";
import { FINGERPRINTABLE_SQL } from "../passes/fingerprint-pass.js";
import { parseFingerprint } from "../similarity/fingerprint.js";
import {
  type FingerprintedFile,
  groupSimilarFiles,
  type SimilarCluster,
  type Yield,
} from "../similarity/group.js";
import type { KeeperCandidate } from "./keeper.js";

/** Whether a file sits in one of the owner's preferred folders. */
export function isPreferredPath(
  settings: Settings,
  file: { root_id: RootId; dir: string },
): boolean {
  return settings.preferredFolders.some(
    (folder) =>
      folder.rootId === file.root_id &&
      (folder.dir === "" || file.dir === folder.dir || file.dir.startsWith(`${folder.dir}/`)),
  );
}

export function toKeeperCandidate(record: FileRecord, settings: Settings): KeeperCandidate {
  return {
    id: record.id,
    relPath: record.rel_path,
    kind: record.kind,
    format: record.format,
    ext: record.ext,
    extensionMismatch: record.ext_mismatch === 1,
    videoCodec: record.video_codec,
    width: record.width,
    height: record.height,
    durationMs: record.duration_ms,
    audioState: audioStateOf(record),
    size: record.size,
    mtimeMs: record.mtime_ms,
    isPreferred: isPreferredPath(settings, record),
  };
}

/**
 * Hashes held by more than one file on disk (hard links to one file count once), as a subquery
 * over `files` yielding `sha256`.
 */
export function exactGroupSql(rootId: RootId | null, params: SqlParams): string {
  if (rootId !== null) {
    params.$root = rootId;
  }

  return `SELECT sha256 FROM files
    WHERE sha256 IS NOT NULL AND is_junk = 0 AND size > 0 ${rootId !== null ? "AND root_id = $root" : ""}
    GROUP BY sha256
    HAVING COUNT(DISTINCT dev || ':' || ino) > 1`;
}

export interface FingerprintCoverage {
  fingerprinted: number;
  fingerprintable: number;
}

const CoverageSchema = z.object({ total: z.number(), done: z.number().nullable() });

export function fingerprintCoverage(
  db: CatalogDatabase,
  rootId: RootId | null,
): FingerprintCoverage {
  const params: SqlParams = {};
  let rootFilter = "";

  if (rootId !== null) {
    params.$root = rootId;
    rootFilter = "AND f.root_id = $root";
  }

  const coverage = db.get(
    `SELECT COUNT(*) AS total, SUM(f.fingerprint IS NOT NULL OR f.fingerprint_error IS NOT NULL) AS done
      FROM files f WHERE ${FINGERPRINTABLE_SQL} ${rootFilter}`,
    CoverageSchema,
    params,
  );

  return { fingerprinted: coverage?.done ?? 0, fingerprintable: coverage?.total ?? 0 };
}

const FingerprintRowSchema = z.object({
  id: FileIdSchema,
  width: z.number(),
  height: z.number(),
  fingerprint: z.string(),
});

/** Clusters every fingerprinted file under a root (or all roots) at a similarity level. */
export async function computeSimilarClusters(
  db: CatalogDatabase,
  request: { rootId: RootId | null; level: SimilarityLevel },
  yieldToEvents: Yield,
): Promise<SimilarCluster[]> {
  const params: SqlParams = {};
  let rootFilter = "";

  if (request.rootId !== null) {
    params.$root = request.rootId;
    rootFilter = "AND f.root_id = $root";
  }

  const rows = db.all(
    `SELECT f.id, f.width, f.height, f.fingerprint FROM files f
      WHERE f.fingerprint IS NOT NULL AND ${FINGERPRINTABLE_SQL} ${rootFilter}`,
    FingerprintRowSchema,
    params,
  );

  const files: FingerprintedFile[] = [];

  for (const row of rows) {
    if (row.height === 0) {
      continue;
    }

    try {
      files.push({
        id: row.id,
        aspect: row.width / row.height,
        fingerprint: parseFingerprint(row.fingerprint),
      });
    } catch {
      // A malformed stored fingerprint is skipped; the next fingerprint version rewrites it.
    }
  }

  return groupSimilarFiles(files, request.level, yieldToEvents);
}
