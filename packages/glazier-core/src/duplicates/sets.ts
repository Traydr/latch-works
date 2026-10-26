import { z } from "zod";

import type { CatalogDatabase, SqlParams } from "../catalog/database.js";
import { type FileRecord, toFileRow } from "../catalog/file-rows.js";
import { getFileRecords } from "../catalog/files.js";
import {
  type DuplicateScope,
  type DuplicateSet,
  type DuplicateSetPage,
  decidingVersions,
  type FileId,
  FileIdSchema,
  type KeepReason,
  type RootId,
  type Settings,
  type Tidy,
} from "../contract.js";
import { loadDetails } from "../passes/detail-pass.js";
import { isVariant, normalizeDetail } from "../similarity/detail.js";
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
  /** Spot variants found every version a picture of its own, so the set is not duplicates. */
  variants: boolean;
  /** With Spot variants on, the set's stills and how many of them have a print (or failed one). */
  comparable: number;
  compared: number;
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

  const details = request.settings.spotVariants
    ? loadDetails(
        db,
        records.flatMap((record) => (isStill(record) ? [record.id] : [])),
      )
    : null;

  for (const component of components) {
    const files = component.ids.flatMap((id) => {
      const record = byId.get(id);

      return record ? [record] : [];
    });

    const set = buildSet(files, component.distance, { settings: request.settings, details });

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

/** Files of one content: byte-identical copies, best first. */
type Version = RankedRecord[];

/** Only stills get detail prints; a video's or animation's frames never line up well enough. */
function isStill(record: FileRecord): boolean {
  return record.fingerprint?.startsWith("s:") ?? false;
}

function contentOf(record: FileRecord): string {
  return record.sha256 ?? `file:${record.id}`;
}

/** Ranked order grouped into versions, best first, each with its copies best first. */
function versionsOf(ranked: readonly RankedRecord[]): Version[] {
  const byContent = new Map<string, Version>();

  for (const entry of ranked) {
    const content = contentOf(entry.record);
    const version = byContent.get(content) ?? [];
    version.push(entry);
    byContent.set(content, version);
  }

  return [...byContent.values()];
}

type Details = ReadonlyMap<FileId, Uint8Array | null>;

/** A version's print: any of its copies' (they hold the same bytes), or null when none has one. */
function printOf(version: Version, details: Details): Float32Array | null {
  for (const entry of version) {
    const print = details.get(entry.id);

    if (print) {
      return normalizeDetail(print);
    }
  }

  return null;
}

/**
 * Which picture each version shows, by content. In ranked order, a version joins the first
 * picture whose best version it is a copy of, or starts a picture when it is a variant of all
 * of them. Null when a version has no print to compare.
 */
function picturesOf(versions: readonly Version[], details: Details): Map<string, number> | null {
  const heads: Float32Array[] = [];
  const pictureOf = new Map<string, number>();

  for (const version of versions) {
    const print = printOf(version, details);
    const first = version[0];

    if (print === null || first === undefined) {
      return null;
    }

    const picture = heads.findIndex((head) => !isVariant(head, print));

    if (picture >= 0) {
      pictureOf.set(contentOf(first.record), picture);
    } else {
      pictureOf.set(contentOf(first.record), heads.length);
      heads.push(print);
    }
  }

  return pictureOf;
}

function folderOf(record: FileRecord): string {
  return `${record.root_id}:${record.dir}`;
}

/**
 * The folder holding the most of the set's pictures, where every picture's copy is best kept so
 * the set stays together; the best-ranked file's folder breaks a tie. Null when no folder holds
 * two pictures, since then there is nothing to keep together.
 */
function homeFolder(ranked: readonly RankedRecord[], pictureOf: ReadonlyMap<string, number>) {
  const picturesIn = new Map<string, Set<number>>();

  for (const entry of ranked) {
    const folder = folderOf(entry.record);
    const pictures = picturesIn.get(folder) ?? new Set<number>();
    pictures.add(pictureOf.get(contentOf(entry.record)) ?? -1);
    picturesIn.set(folder, pictures);
  }

  const most = Math.max(...[...picturesIn.values()].map((pictures) => pictures.size));

  if (most < 2) {
    return null;
  }

  const home = ranked.find((entry) => picturesIn.get(folderOf(entry.record))?.size === most);

  return home ? folderOf(home.record) : null;
}

interface Grouping {
  versions: Version[];
  /** Each version's picture, by position; null without Spot variants. */
  pictures: number[] | null;
}

/**
 * Versions grouped into pictures, picture by picture with each one's best version first, and the
 * home folder ranking copies; versions alone when there is nothing to compare.
 */
function groupPictures(candidates: readonly RankedRecord[], details: Details | null): Grouping {
  const versions = versionsOf(rankKeepers(candidates).ranked);
  const pictureOf = details === null || versions.length < 2 ? null : picturesOf(versions, details);

  if (pictureOf === null) {
    return { versions, pictures: null };
  }

  const home = homeFolder(versions.flat(), pictureOf);

  const reranked = versionsOf(
    rankKeepers(
      candidates.map((entry) => ({ ...entry, inHomeFolder: folderOf(entry.record) === home })),
    ).ranked,
  );

  // Pictures are numbered by their best version, and a picture's versions sit together.
  const order = new Map<number, number>();

  for (const version of reranked) {
    const picture = version[0] ? (pictureOf.get(contentOf(version[0].record)) ?? 0) : 0;

    if (!order.has(picture)) {
      order.set(picture, order.size);
    }
  }

  const numbered = reranked.map((version) => {
    const picture = version[0] ? (pictureOf.get(contentOf(version[0].record)) ?? 0) : 0;

    return { version, picture: order.get(picture) ?? 0 };
  });

  numbered.sort((left, right) => left.picture - right.picture);

  return {
    versions: numbered.map((entry) => entry.version),
    pictures: numbered.map((entry) => entry.picture),
  };
}

function buildSet(
  files: readonly FileRecord[],
  distance: number,
  context: { settings: Settings; details: Details | null },
): ComputedSet | null {
  const candidates = files.map((record) => ({
    ...toKeeperCandidate(record, context.settings),
    record,
  }));

  const { versions, pictures } = groupPictures(candidates, context.details);
  const [bestVersion, secondVersion] = versions;
  const best = bestVersion?.[0];

  if (bestVersion === undefined || best === undefined) {
    return null;
  }

  const inodes = new Set(bestVersion.map((entry) => inodeOf(entry.record)));

  if (secondVersion === undefined && inodes.size < 2) {
    return null;
  }

  // Each picture keeps its best version's best copy; without pictures, the set keeps one file.
  const keep =
    pictures === null
      ? [best.id]
      : versions.flatMap((version, index) =>
          index === 0 || pictures[index] !== pictures[index - 1] ? (version[0]?.id ?? []) : [],
        );

  const removed = removalsFor(files, keep);
  const freed = new Map(removed.map((record) => [inodeOf(record), record.size]));
  const linkCounts = new Map<string, number>();

  for (const record of files) {
    linkCounts.set(inodeOf(record), (linkCounts.get(inodeOf(record)) ?? 0) + 1);
  }

  const fileIds = files.map((record) => record.id);
  const exact = secondVersion === undefined;
  const kind = exact ? "exact" : "similar";
  const variants = pictures !== null && new Set(pictures).size === versions.length;
  const stills = context.details === null || exact ? [] : files.filter(isStill);

  const set = {
    key: exact ? `exact:${best.record.sha256}` : `similar:${Math.min(...fileIds)}`,
    kind,
    versions: versions.map((version) => ({
      files: version.map((entry) => toFileRow(entry.record)),
    })),
    pictures,
    keep,
    keepReason: "name-order",
    reclaimableBytes: [...freed.values()].reduce((sum, size) => sum + size, 0),
    hardLinkedIds: files.flatMap((record) =>
      (linkCounts.get(inodeOf(record)) ?? 0) > 1 ? [record.id] : [],
    ),
    distance: exact ? null : distance,
  } satisfies ComputedSet["set"];

  return {
    set: { ...set, keepReason: decidingReason(set, versions) },
    fileIds,
    extraCopies: removed.length,
    variants,
    comparable: stills.length,
    compared: stills.filter((record) => context.details?.has(record.id)).length,
  };
}

/** The rule that kept the deciding version over its runner-up (see `decidingVersions`). */
function decidingReason(set: ComputedSet["set"], versions: readonly Version[]): KeepReason {
  const pair = decidingVersions(set);
  const kept = pair ? versions[pair.kept]?.[0] : versions[0]?.[0];
  const runnerUp = pair ? versions[pair.runnerUp]?.[0] : versions[0]?.[1];

  if (kept !== undefined && runnerUp !== undefined) {
    return keepReason(kept, runnerUp);
  }

  return set.pictures === null ? "name-order" : "different-pictures";
}

function inScope(entry: ComputedSet, scope: DuplicateScope): boolean {
  switch (scope) {
    case "all":
      return !entry.variants;
    case "exact":
      return entry.set.kind === "exact";
    case "similar":
      return entry.set.kind === "similar" && !entry.variants;
    case "variants":
      return entry.variants;
    default: {
      const _exhaustive: never = scope;

      return _exhaustive;
    }
  }
}

/** The sets the owner has not dismissed, in a scope, most bytes to reclaim first. */
export function openSets(
  computed: readonly ComputedSet[],
  dismissals: Dismissals,
  scope: DuplicateScope,
): ComputedSet[] {
  return computed.filter(
    (entry) => inScope(entry, scope) && dismissals.covering(entry.fileIds) === null,
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
): Omit<DuplicateSetPage, "fingerprinted" | "fingerprintable"> {
  const counts = { exact: 0, similar: 0, variants: 0, dismissed: 0 };
  const selected: DuplicateSet[] = [];
  let openReclaimableBytes = 0;
  let comparable = 0;
  let compared = 0;

  for (const entry of computed) {
    const dismissalId = dismissals.covering(entry.fileIds);

    if (dismissalId !== null) {
      counts.dismissed += 1;
    } else if (entry.variants) {
      counts.variants += 1;
    } else {
      counts[entry.set.kind] += 1;
      openReclaimableBytes += entry.set.reclaimableBytes;
    }

    if (dismissalId === null) {
      comparable += entry.comparable;
      compared += entry.compared;
    }

    // Dismissed sets are listed whatever Spot variants made of them.
    const listed = request.dismissed || inScope(entry, request.scope);

    if ((dismissalId !== null) === request.dismissed && listed) {
      selected.push({ ...entry.set, dismissalId });
    }
  }

  return {
    total: selected.length,
    reclaimableBytes: selected.reduce((sum, set) => sum + set.reclaimableBytes, 0),
    counts,
    openReclaimableBytes,
    compared,
    comparable,
    sets: selected.slice(request.offset, request.offset + request.limit),
  };
}
