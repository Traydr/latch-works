import { z } from "zod";

import type { CatalogDatabase, SqlParams } from "../catalog/database.js";
import { type FileRecord, toFileRow } from "../catalog/file-rows.js";
import { getFileRecords } from "../catalog/files.js";
import {
  type DuplicateScope,
  type DuplicateSet,
  type DuplicateSetPage,
  type FileId,
  FileIdSchema,
  type RootId,
  type Settings,
  type Tidy,
} from "../contract.js";
import { DisjointSets, type SimilarCluster } from "../similarity/group.js";
import type { Dismissals } from "./dismissals.js";
import { type KeeperCandidate, keepReason, rankKeepers } from "./keeper.js";
import { exactGroupSql, toKeeperCandidate } from "./queries.js";

/** A duplicate set as computed from the catalog, before the owner's dismissals apply. */
export interface ComputedSet {
  set: Omit<DuplicateSet, "dismissalId">;
  fileIds: FileId[];
  /** Files the suggested resolution moves to holding. */
  extraCopies: number;
}

function inodeOf(record: { dev: string; ino: string }): string {
  return `${record.dev}:${record.ino}`;
}

/**
 * The files a resolution keeping `keep` moves to holding: every other file, except those that
 * share their bytes on disk with a kept file, since holding a hard link frees nothing.
 */
export function removalsFor<T extends { id: FileId; dev: string; ino: string }>(
  files: readonly T[],
  keep: readonly FileId[],
): T[] {
  const keepIds = new Set(keep);

  const keptInodes = new Set(
    files.flatMap((file) => (keepIds.has(file.id) ? [inodeOf(file)] : [])),
  );

  return files.filter((file) => !keepIds.has(file.id) && !keptInodes.has(inodeOf(file)));
}

const ExactMemberSchema = z.object({ id: FileIdSchema, sha256: z.string() });

/**
 * Every duplicate set under a root (or all roots). Byte-identical files (same SHA-256 on more
 * than one inode) and similar clusters link files; each connected group is one set, so a file
 * is in one set only. A set needs two versions, or one version on two inodes: hard links of one
 * file are not duplicates. Sorted by bytes to reclaim, most first.
 */
export function buildDuplicateSets(
  db: CatalogDatabase,
  request: { rootId: RootId | null; settings: Settings; clusters: readonly SimilarCluster[] },
): ComputedSet[] {
  const params: SqlParams = {};
  const groups = exactGroupSql(request.rootId, params);

  const members = db.all(
    `SELECT f.id, f.sha256 FROM files f
      WHERE f.sha256 IN (${groups}) AND f.is_junk = 0 AND f.size > 0
        ${request.rootId !== null ? "AND f.root_id = $root" : ""}`,
    ExactMemberSchema,
    params,
  );

  const links = new DisjointSets<FileId>();
  const firstBySha = new Map<string, FileId>();

  for (const member of members) {
    const first = firstBySha.get(member.sha256);

    if (first === undefined) {
      firstBySha.set(member.sha256, member.id);
    } else {
      links.union(first, member.id, 0);
    }
  }

  for (const cluster of request.clusters) {
    const [first, ...rest] = cluster.ids;

    for (const id of rest) {
      if (first !== undefined) {
        links.union(first, id, cluster.distance);
      }
    }
  }

  const components = links.clusters();

  const records = getFileRecords(
    db,
    components.flatMap((component) => component.ids),
  );

  const byId = new Map(records.map((record) => [record.id, record]));
  const sets: ComputedSet[] = [];

  for (const component of components) {
    const files = component.ids.flatMap((id) => {
      const record = byId.get(id);

      return record ? [record] : [];
    });

    const set = buildSet(files, component.distance, request.settings);

    if (set !== null) {
      sets.push(set);
    }
  }

  return sets.sort(
    (left, right) =>
      right.set.reclaimableBytes - left.set.reclaimableBytes ||
      compareText(left.set.key, right.set.key),
  );
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

type RankedRecord = KeeperCandidate & { record: FileRecord };

function buildSet(
  files: readonly FileRecord[],
  distance: number,
  settings: Settings,
): ComputedSet | null {
  const { ranked } = rankKeepers<RankedRecord>(
    files.map((record) => ({ ...toKeeperCandidate(record, settings), record })),
  );

  // Ranked order groups into versions best first, each with its copies best first.
  const versionsByContent = new Map<string, RankedRecord[]>();

  for (const entry of ranked) {
    const content = entry.record.sha256 ?? `file:${entry.record.id}`;
    const version = versionsByContent.get(content) ?? [];
    version.push(entry);
    versionsByContent.set(content, version);
  }

  const versions = [...versionsByContent.values()];
  const [bestVersion, secondVersion] = versions;
  const best = bestVersion?.[0];

  if (bestVersion === undefined || best === undefined) {
    return null;
  }

  const inodes = new Set(bestVersion.map((entry) => inodeOf(entry.record)));

  if (secondVersion === undefined && inodes.size < 2) {
    return null;
  }

  const runnerUp = secondVersion === undefined ? bestVersion[1] : secondVersion[0];
  const keep = [best.id];
  const removed = removalsFor(files, keep);
  const freed = new Map(removed.map((record) => [inodeOf(record), record.size]));
  const linkCounts = new Map<string, number>();

  for (const record of files) {
    linkCounts.set(inodeOf(record), (linkCounts.get(inodeOf(record)) ?? 0) + 1);
  }

  const fileIds = files.map((record) => record.id);
  const exact = secondVersion === undefined;

  return {
    set: {
      key: exact ? `exact:${best.record.sha256}` : `similar:${Math.min(...fileIds)}`,
      kind: exact ? "exact" : "similar",
      versions: versions.map((version) => ({
        files: version.map((entry) => toFileRow(entry.record)),
      })),
      keep,
      keepReason: runnerUp === undefined ? "name-order" : keepReason(best, runnerUp),
      reclaimableBytes: [...freed.values()].reduce((sum, size) => sum + size, 0),
      hardLinkedIds: files.flatMap((record) =>
        (linkCounts.get(inodeOf(record)) ?? 0) > 1 ? [record.id] : [],
      ),
      distance: exact ? null : distance,
    },
    fileIds,
    extraCopies: removed.length,
  };
}

function inScope(kind: DuplicateSet["kind"], scope: DuplicateScope): boolean {
  return scope === "all" || scope === kind;
}

/** The sets the owner has not dismissed, in a scope, most bytes to reclaim first. */
export function openSets(
  computed: readonly ComputedSet[],
  dismissals: Dismissals,
  scope: DuplicateScope,
): ComputedSet[] {
  return computed.filter(
    (entry) => inScope(entry.set.kind, scope) && dismissals.covering(entry.fileIds) === null,
  );
}

/** Totals over sets: how many, the files their suggestions hold and the bytes that frees. */
export function duplicateTotals(sets: readonly ComputedSet[]): Tidy["duplicates"]["exact"] {
  let extraCopies = 0;
  let reclaimableBytes = 0;

  for (const entry of sets) {
    extraCopies += entry.extraCopies;
    reclaimableBytes += entry.set.reclaimableBytes;
  }

  return { sets: sets.length, extraCopies, reclaimableBytes };
}

/** One page of open (or dismissed) sets in a scope, with counts that ignore the scope. */
export function pageDuplicateSets(
  computed: readonly ComputedSet[],
  dismissals: Dismissals,
  request: { scope: DuplicateScope; dismissed: boolean; offset: number; limit: number },
): Pick<DuplicateSetPage, "total" | "reclaimableBytes" | "counts" | "sets"> {
  const counts = { exact: 0, similar: 0, dismissed: 0 };
  const selected: DuplicateSet[] = [];

  for (const entry of computed) {
    const dismissalId = dismissals.covering(entry.fileIds);

    if (dismissalId !== null) {
      counts.dismissed += 1;
    } else {
      counts[entry.set.kind] += 1;
    }

    if ((dismissalId !== null) === request.dismissed && inScope(entry.set.kind, request.scope)) {
      selected.push({ ...entry.set, dismissalId });
    }
  }

  return {
    total: selected.length,
    reclaimableBytes: selected.reduce((sum, set) => sum + set.reclaimableBytes, 0),
    counts,
    sets: selected.slice(request.offset, request.offset + request.limit),
  };
}
