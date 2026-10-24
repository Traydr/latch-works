import { z } from "zod";

import type { CatalogDatabase, SqlParams } from "../catalog/database.js";
import {
  audioStateOf,
  FILE_COLUMNS,
  FILES_FROM,
  type FileRecord,
  FileRecordSchema,
  toFileRow,
} from "../catalog/file-rows.js";
import { getFileRecords } from "../catalog/files.js";
import type {
  ExactGroup,
  FileId,
  RootId,
  Settings,
  SimilarGroup,
  SimilarityLevel,
} from "../contract.js";
import { FileIdSchema } from "../contract.js";
import { FINGERPRINTABLE_SQL } from "../passes/fingerprint-pass.js";
import { parseFingerprint } from "../similarity/fingerprint.js";
import {
  type FingerprintedFile,
  groupSimilarFiles,
  type SimilarCluster,
  type Yield,
} from "../similarity/group.js";
import { type KeeperCandidate, rankKeepers } from "./keeper.js";

/** Whether a file sits in one of the owner's protected folders. */
export function isProtectedPath(
  settings: Settings,
  file: { root_id: RootId; dir: string },
): boolean {
  return settings.protectedFolders.some(
    (folder) =>
      folder.rootId === file.root_id &&
      (folder.dir === "" || file.dir === folder.dir || file.dir.startsWith(`${folder.dir}/`)),
  );
}

function toKeeperCandidate(record: FileRecord, settings: Settings): KeeperCandidate {
  return {
    id: record.id,
    relPath: record.rel_path,
    kind: record.kind,
    format: record.format,
    videoCodec: record.video_codec,
    width: record.width,
    height: record.height,
    durationMs: record.duration_ms,
    audioState: audioStateOf(record),
    size: record.size,
    mtimeMs: record.mtime_ms,
    isProtected: isProtectedPath(settings, record),
  };
}

/** Files in keeper order, best first, the order every group's members are returned in. */
function rankRecords(records: readonly FileRecord[], settings: Settings): FileRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));

  return rankKeepers(records.map((record) => toKeeperCandidate(record, settings))).flatMap(
    (candidate) => {
      const record = byId.get(candidate.id);

      return record ? [record] : [];
    },
  );
}

const ExactGroupRowSchema = z.object({
  sha256: z.string(),
  size: z.number(),
  physical: z.number(),
});

const TotalsSchema = z.object({
  groups: z.number(),
  files: z.number().nullable(),
  reclaimable: z.number().nullable(),
});

function exactGroupSql(rootId: RootId | null, params: SqlParams): string {
  if (rootId !== null) {
    params.$root = rootId;
  }

  return `SELECT sha256, MAX(size) AS size, COUNT(*) AS copies,
      COUNT(DISTINCT dev || ':' || ino) AS physical
    FROM files
    WHERE sha256 IS NOT NULL AND is_junk = 0 AND size > 0 ${rootId !== null ? "AND root_id = $root" : ""}
    GROUP BY sha256
    HAVING COUNT(DISTINCT dev || ':' || ino) > 1`;
}

export interface DuplicateTotals {
  groups: number;
  files: number;
  reclaimableBytes: number;
}

export function exactDuplicateTotals(db: CatalogDatabase, rootId: RootId | null): DuplicateTotals {
  const params: SqlParams = {};

  const totals = db.get(
    `SELECT COUNT(*) AS groups, SUM(copies) AS files, SUM((physical - 1) * size) AS reclaimable
      FROM (${exactGroupSql(rootId, params)})`,
    TotalsSchema,
    params,
  );

  return {
    groups: totals?.groups ?? 0,
    files: totals?.files ?? 0,
    reclaimableBytes: totals?.reclaimable ?? 0,
  };
}

export function listExactGroups(
  db: CatalogDatabase,
  page: { rootId: RootId | null; offset: number; limit: number },
  settings: Settings,
): ExactGroup[] {
  const params: SqlParams = { $limit: page.limit, $offset: page.offset };

  const groups = db.all(
    `${exactGroupSql(page.rootId, params)}
      ORDER BY (physical - 1) * size DESC, sha256 LIMIT $limit OFFSET $offset`,
    ExactGroupRowSchema,
    params,
  );

  return groups.map((group) => {
    const memberParams: SqlParams = { $sha: group.sha256 };
    let rootFilter = "";

    if (page.rootId !== null) {
      memberParams.$root = page.rootId;
      rootFilter = "AND f.root_id = $root";
    }

    const members = rankRecords(
      db.all(
        `SELECT ${FILE_COLUMNS} FROM ${FILES_FROM}
          WHERE f.sha256 = $sha AND f.is_junk = 0 ${rootFilter}`,
        FileRecordSchema,
        memberParams,
      ),
      settings,
    );

    const linkCounts = new Map<string, number>();

    for (const member of members) {
      const key = `${member.dev}:${member.ino}`;
      linkCounts.set(key, (linkCounts.get(key) ?? 0) + 1);
    }

    return {
      sha256: group.sha256,
      size: group.size,
      physicalCopies: group.physical,
      reclaimableBytes: (group.physical - 1) * group.size,
      members: members.map(toFileRow),
      hardLinkedIds: members.flatMap((member) =>
        (linkCounts.get(`${member.dev}:${member.ino}`) ?? 0) > 1 ? [member.id] : [],
      ),
    };
  });
}

const FingerprintRowSchema = z.object({
  id: FileIdSchema,
  width: z.number(),
  height: z.number(),
  fingerprint: z.string().nullable(),
  sha256: z.string().nullable(),
  size: z.number(),
});

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

/** A similar group before its members are loaded: ids in keeper order. */
export interface SimilarClusterSummary {
  id: number;
  kind: SimilarCluster["kind"];
  distance: number;
  ids: FileId[];
  reclaimableBytes: number;
}

/**
 * Clusters every fingerprinted file under a root (or all roots) at a similarity level. Clusters
 * whose members are all byte-identical are left to the exact view.
 */
export async function computeSimilarClusters(
  db: CatalogDatabase,
  request: { rootId: RootId | null; level: SimilarityLevel },
  yieldToEvents: Yield,
): Promise<SimilarClusterSummary[]> {
  const params: SqlParams = {};
  let rootFilter = "";

  if (request.rootId !== null) {
    params.$root = request.rootId;
    rootFilter = "AND f.root_id = $root";
  }

  const rows = db.all(
    `SELECT f.id, f.width, f.height, f.fingerprint, f.sha256, f.size FROM files f
      WHERE f.fingerprint IS NOT NULL AND ${FINGERPRINTABLE_SQL} ${rootFilter}`,
    FingerprintRowSchema,
    params,
  );

  const byId = new Map(rows.map((row) => [row.id, row]));
  const files: FingerprintedFile[] = [];

  for (const row of rows) {
    if (row.fingerprint === null || row.height === 0) {
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

  const clusters = await groupSimilarFiles(files, request.level, yieldToEvents);
  const summaries: SimilarClusterSummary[] = [];

  for (const cluster of clusters) {
    const members = cluster.ids.flatMap((id) => {
      const row = byId.get(id);

      return row ? [row] : [];
    });

    const hashes = new Set(members.map((member) => member.sha256 ?? `unhashed:${member.id}`));

    if (hashes.size < 2) {
      continue;
    }

    const sizes = members.map((member) => member.size);
    const total = sizes.reduce((sum, size) => sum + size, 0);

    summaries.push({
      id: 0,
      kind: cluster.kind,
      distance: cluster.distance,
      ids: cluster.ids,
      reclaimableBytes: total - Math.max(...sizes),
    });
  }

  summaries.sort((left, right) => right.reclaimableBytes - left.reclaimableBytes);
  summaries.forEach((summary, index) => {
    summary.id = index + 1;
  });

  return summaries;
}

export function loadSimilarGroups(
  db: CatalogDatabase,
  clusters: readonly SimilarClusterSummary[],
  settings: Settings,
): SimilarGroup[] {
  const records = getFileRecords(
    db,
    clusters.flatMap((cluster) => cluster.ids),
  );

  const byId = new Map(records.map((record) => [record.id, record]));

  return clusters.map((cluster) => ({
    id: cluster.id,
    kind: cluster.kind,
    distance: cluster.distance,
    members: rankRecords(
      cluster.ids.flatMap((id) => {
        const record = byId.get(id);

        return record ? [record] : [];
      }),
      settings,
    ).map(toFileRow),
  }));
}
