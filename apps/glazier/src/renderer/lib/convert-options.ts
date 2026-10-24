import type { OptimizeCategory, RootId, Tidy } from "@latch-works/glazier-core/contract";
import { useEffect, useState, useSyncExternalStore } from "react";

import { call } from "./api";
import { formatBytes } from "./format";

/** Convert's three switches; videos cover both lossless and re-encoded moves to MP4. */
export const CONVERT_GROUPS = [
  {
    id: "pictures",
    label: "Pictures → AVIF",
    categories: ["still-to-avif"],
    noun: ["picture", "pictures"],
    target: "AVIF",
  },
  {
    id: "animations",
    label: "Animations → MP4",
    categories: ["animation-to-mp4"],
    noun: ["animation", "animations"],
    target: "MP4",
  },
  {
    id: "videos",
    label: "Videos → MP4",
    categories: ["video-remux", "video-convert"],
    noun: ["video", "videos"],
    target: "MP4",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  categories: readonly OptimizeCategory[];
  noun: readonly [string, string];
  target: string;
}>;

export type ConvertGroup = (typeof CONVERT_GROUPS)[number];

type ConvertGroupId = ConvertGroup["id"];

const STORAGE_KEY = "glazier.convert-groups";

const ALL_GROUPS: readonly ConvertGroupId[] = CONVERT_GROUPS.map((group) => group.id);

function isGroupId(value: unknown): value is ConvertGroupId {
  return ALL_GROUPS.some((id) => id === value);
}

function readGroups(): ReadonlySet<ConvertGroupId> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");

    return Array.isArray(stored) ? new Set(stored.filter(isGroupId)) : new Set(ALL_GROUPS);
  } catch {
    return new Set(ALL_GROUPS);
  }
}

let enabled = readGroups();

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

interface ConvertGroups {
  enabled: ReadonlySet<ConvertGroupId>;
  setEnabled: (id: ConvertGroupId, on: boolean) => void;
}

/**
 * The kinds of file Convert changes, shared by Convert's Options and Overview's Tidy up, and kept
 * across launches.
 */
export function useConvertGroups(): ConvertGroups {
  const current = useSyncExternalStore(subscribe, () => enabled);

  return {
    enabled: current,
    setEnabled: (id, on) => {
      const next = new Set(enabled);

      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }

      enabled = next;
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));

      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function categoryEntry(tidy: Tidy, category: OptimizeCategory) {
  return (
    tidy.convert.categories.find((entry) => entry.category === category) ?? {
      category,
      files: 0,
      bytes: 0,
    }
  );
}

interface Totals {
  files: number;
  bytes: number;
}

export function groupTotals(tidy: Tidy, group: ConvertGroup): Totals {
  let files = 0;
  let bytes = 0;

  for (const category of group.categories) {
    const entry = categoryEntry(tidy, category);

    files += entry.files;
    bytes += entry.bytes;
  }

  return { files, bytes };
}

/** Size after conversion as a share of before; null when the estimate failed or sampled nothing. */
type Ratio = number | null;

/** Estimates by root, category and the files they cover; the engine caches them as well. */
const ratioCache = new Map<string, Ratio>();

function ratioKey(rootId: RootId, category: OptimizeCategory, files: number, bytes: number) {
  return `${rootId}:${category}:${files}:${bytes}`;
}

/** An estimate of a set of files' size after converting, or why there is none yet. */
export type Estimate =
  | { state: "pending" }
  | { state: "unknown" }
  | { state: "known"; before: number; after: number };

interface ConvertEstimates {
  estimate: (categories: readonly OptimizeCategory[]) => Estimate;
}

/**
 * Estimates what converting would leave, per category, from a small sample the engine converts
 * once. `estimate` sums any categories; a category that failed makes the sum unknown.
 */
export function useConvertEstimates(rootId: RootId, tidy: Tidy | null): ConvertEstimates {
  const [, setVersion] = useState(0);

  const wanted = tidy
    ? CONVERT_GROUPS.flatMap((group) =>
        group.categories.flatMap((category) => {
          const entry = categoryEntry(tidy, category);

          return entry.files > 0
            ? [`${category}|${ratioKey(rootId, category, entry.files, entry.bytes)}`]
            : [];
        }),
      ).join(",")
    : "";

  useEffect(() => {
    let cancelled = false;

    for (const item of wanted.split(",")) {
      const [category, key] = item.split("|");

      const known = CONVERT_GROUPS.flatMap((group) => [...group.categories]).find(
        (candidate) => candidate === category,
      );

      if (known === undefined || key === undefined || ratioCache.has(key)) {
        continue;
      }

      const settle = (ratio: Ratio) => {
        ratioCache.set(key, ratio);

        if (!cancelled) {
          setVersion((version) => version + 1);
        }
      };

      call("estimateOptimize", { rootId, category: known }).then(
        (estimate) => settle(estimate.sampled > 0 ? estimate.ratio : null),
        () => settle(null),
      );
    }

    return () => {
      cancelled = true;
    };
  }, [wanted, rootId]);

  return {
    estimate: (categories) => {
      if (!tidy) {
        return { state: "pending" };
      }

      let before = 0;
      let after = 0;
      let pending = false;
      let unknown = false;

      for (const category of categories) {
        const entry = categoryEntry(tidy, category);

        if (entry.files === 0) {
          continue;
        }

        const ratio = ratioCache.get(ratioKey(rootId, category, entry.files, entry.bytes));

        before += entry.bytes;

        if (ratio === undefined) {
          pending = true;
        } else if (ratio === null) {
          unknown = true;
        } else {
          after += entry.bytes * ratio;
        }
      }

      return unknown
        ? { state: "unknown" }
        : pending
          ? { state: "pending" }
          : { state: "known", before, after };
    },
  };
}

/** Size after converting as a share of before, so one file's estimate is its size times this. */
export function estimateRatio(estimate: Estimate): number | null {
  return estimate.state === "known" && estimate.before > 0
    ? estimate.after / estimate.before
    : null;
}

/** "1.7 MB → about 700 KB", or what stands in for the estimate while there is none. */
export function describeEstimate(bytes: number, estimate: Estimate): string {
  switch (estimate.state) {
    case "pending":
      return `${formatBytes(bytes)} → estimating…`;
    case "unknown":
      return `${formatBytes(bytes)} → size unknown`;
    case "known":
      return `${formatBytes(bytes)} → about ${formatBytes(estimate.after)}`;
    default: {
      const _exhaustive: never = estimate;

      return _exhaustive;
    }
  }
}
