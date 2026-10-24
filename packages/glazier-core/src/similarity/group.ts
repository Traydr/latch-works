import type { FileId, SimilarityLevel } from "../contract.js";
import type { Fingerprint } from "./fingerprint.js";
import { type Hash64, hammingDistance } from "./phash.js";

/** Two prints can match only when their aspect ratios differ by less than about 3%. */
const ASPECT_TOLERANCE = 0.03;

/** Two motion prints can match only when their durations differ by less than this… */
const DURATION_TOLERANCE_MS = 1500;

/** …or this share of the longer one, whichever is larger. */
const DURATION_TOLERANCE_RATIO = 0.03;

/**
 * The largest bit distance (of 64) that still counts as the same picture. Recompression and
 * resizing land well under 8; a different crop or an overlay lands past 12.
 */
const STILL_THRESHOLDS = { strict: 4, balanced: 8, loose: 12 } as const satisfies Record<
  SimilarityLevel,
  number
>;

/** For motion, the median of the five frame distances must be under this. */
const MOTION_THRESHOLDS = { strict: 5, balanced: 9, loose: 13 } as const satisfies Record<
  SimilarityLevel,
  number
>;

export interface FingerprintedFile {
  id: FileId;
  /** Display width over height. */
  aspect: number;
  fingerprint: Fingerprint;
}

export interface SimilarCluster {
  kind: "image" | "video";
  /** The largest distance on a link that joined this cluster. */
  distance: number;
  ids: FileId[];
}

/** Lets a long comparison loop hand the event loop back so the engine keeps answering. */
export type Yield = () => Promise<void>;

const COMPARISONS_PER_YIELD = 2_000_000;

/**
 * Groups files whose fingerprints say they show the same picture or the same footage, however
 * they were encoded. Stills only meet stills and motion only motion. Candidates are bucketed by
 * aspect ratio so most pairs are never compared.
 */
export async function groupSimilarFiles(
  files: readonly FingerprintedFile[],
  level: SimilarityLevel,
  yieldToEvents: Yield,
): Promise<SimilarCluster[]> {
  const stills: StillEntry[] = [];
  const motions: MotionEntry[] = [];

  for (const file of files) {
    if (!(file.aspect > 0) || !Number.isFinite(file.aspect)) {
      continue;
    }

    const logAspect = Math.log(file.aspect);

    if (file.fingerprint.kind === "still") {
      stills.push({ id: file.id, logAspect, hash: file.fingerprint.hash });
    } else if (file.fingerprint.frames.length > 0) {
      motions.push({
        id: file.id,
        logAspect,
        durationMs: file.fingerprint.durationMs,
        frames: file.fingerprint.frames,
      });
    }
  }

  const stillClusters = await clusterWithinAspectBins(
    stills,
    (left, right) => {
      const distance = hammingDistance(left.hash, right.hash);

      return distance <= STILL_THRESHOLDS[level] ? distance : null;
    },
    { yieldToEvents },
  );

  const motionClusters = await clusterWithinAspectBins(
    motions,
    (left, right) => motionDistance(left, right, MOTION_THRESHOLDS[level]),
    { yieldToEvents },
  );

  return [
    ...stillClusters.map((cluster) => ({ kind: "image" as const, ...cluster })),
    ...motionClusters.map((cluster) => ({ kind: "video" as const, ...cluster })),
  ];
}

interface StillEntry {
  id: FileId;
  logAspect: number;
  hash: Hash64;
}

interface MotionEntry {
  id: FileId;
  logAspect: number;
  durationMs: number;
  frames: Hash64[];
}

/** The median frame distance when two motion prints match, or null when they do not. */
function motionDistance(left: MotionEntry, right: MotionEntry, threshold: number): number | null {
  const longer = Math.max(left.durationMs, right.durationMs);
  const tolerance = Math.max(DURATION_TOLERANCE_MS, longer * DURATION_TOLERANCE_RATIO);

  if (Math.abs(left.durationMs - right.durationMs) > tolerance) {
    return null;
  }

  const count = Math.min(left.frames.length, right.frames.length);
  const distances: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const leftFrame = left.frames[index];
    const rightFrame = right.frames[index];

    if (leftFrame && rightFrame) {
      distances.push(hammingDistance(leftFrame, rightFrame));
    }
  }

  distances.sort((a, b) => a - b);
  const median = distances[Math.floor(distances.length / 2)];

  return median !== undefined && median <= threshold ? median : null;
}

interface ClusterOptions {
  yieldToEvents: Yield;
}

async function clusterWithinAspectBins<T extends { id: FileId; logAspect: number }>(
  entries: readonly T[],
  match: (left: T, right: T) => number | null,
  options: ClusterOptions,
): Promise<Array<{ distance: number; ids: FileId[] }>> {
  const bins = new Map<number, T[]>();

  for (const entry of entries) {
    const bin = Math.round(entry.logAspect / ASPECT_TOLERANCE);
    const members = bins.get(bin);

    if (members) {
      members.push(entry);
    } else {
      bins.set(bin, [entry]);
    }
  }

  const sets = new DisjointSets<FileId>();
  let sinceYield = 0;

  const compare = (left: T, right: T) => {
    if (Math.abs(left.logAspect - right.logAspect) > ASPECT_TOLERANCE) {
      return;
    }

    const distance = match(left, right);

    if (distance !== null) {
      sets.union(left.id, right.id, distance);
    }
  };

  for (const [bin, members] of bins) {
    // Each bin meets itself and the next one up, so every neighbouring pair is seen once.
    const neighbours = bins.get(bin + 1) ?? [];

    for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
      const left = members[leftIndex];

      if (!left) {
        continue;
      }

      for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
        const right = members[rightIndex];

        if (right) {
          compare(left, right);
        }
      }

      for (const right of neighbours) {
        compare(left, right);
      }

      sinceYield += members.length - leftIndex + neighbours.length;

      if (sinceYield >= COMPARISONS_PER_YIELD) {
        sinceYield = 0;
        await options.yieldToEvents();
      }
    }
  }

  return sets.clusters();
}

/** Union–find over file ids, tracking the largest link distance in each set. */
class DisjointSets<K> {
  private readonly parent = new Map<K, K>();

  private readonly distance = new Map<K, number>();

  union(left: K, right: K, linkDistance: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);

    const distance = Math.max(
      linkDistance,
      this.distance.get(leftRoot) ?? 0,
      this.distance.get(rightRoot) ?? 0,
    );

    if (leftRoot !== rightRoot) {
      this.parent.set(rightRoot, leftRoot);
    }

    this.distance.set(leftRoot, distance);
  }

  clusters(): Array<{ distance: number; ids: K[] }> {
    const byRoot = new Map<K, K[]>();

    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const members = byRoot.get(root);

      if (members) {
        members.push(key);
      } else {
        byRoot.set(root, [key]);
      }
    }

    const clusters: Array<{ distance: number; ids: K[] }> = [];

    for (const [root, ids] of byRoot) {
      if (ids.length > 1) {
        clusters.push({ distance: this.distance.get(root) ?? 0, ids });
      }
    }

    return clusters;
  }

  private find(key: K): K {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);

      return key;
    }

    let root = key;

    for (let next = this.parent.get(root); next !== undefined && next !== root; ) {
      root = next;
      next = this.parent.get(root);
    }

    // Path compression keeps later finds short.
    let current = key;

    while (current !== root) {
      const next = this.parent.get(current);
      this.parent.set(current, root);

      if (next === undefined) {
        break;
      }

      current = next;
    }

    return root;
  }
}
