import path from "node:path";
import type { SyncPlanAction } from "@latch-works/media-index";
import type { HashMode } from "./types.js";

export function resolveHashMode(options: {
  defaultMode?: HashMode;
  hashFiles?: boolean;
  hashMode?: HashMode;
}): HashMode {
  if (options.hashMode) {
    return options.hashMode;
  }
  if (options.hashFiles !== undefined) {
    return options.hashFiles ? "all" : "none";
  }
  return options.defaultMode ?? "none";
}

/** A capped slice of plan items plus the number the cap left behind. */
export interface CappedPlanItems<T> {
  items: T[];
  omittedCount: number;
}

export function selectChangedItems<T extends { action: SyncPlanAction }>(items: T[]): T[] {
  return items.filter((item) => item.action !== "keep");
}

export function selectUploadUpdateItems<T extends { action: SyncPlanAction }>(
  changedItems: T[],
  maxChanges?: number,
): CappedPlanItems<T> {
  const uploadUpdateItems = changedItems.filter(
    (item) => item.action === "upload" || item.action === "update",
  );

  if (!maxChanges || uploadUpdateItems.length <= maxChanges) {
    return { items: uploadUpdateItems, omittedCount: 0 };
  }

  return {
    items: uploadUpdateItems.slice(0, maxChanges),
    omittedCount: uploadUpdateItems.length - maxChanges,
  };
}

export function selectDeleteItems<T extends { action: SyncPlanAction }>(
  changedItems: T[],
  maxChanges?: number,
): CappedPlanItems<T> {
  const deleteItems = changedItems.filter((item) => item.action === "delete");

  if (!maxChanges || deleteItems.length <= maxChanges) {
    return { items: deleteItems, omittedCount: 0 };
  }

  return {
    items: deleteItems.slice(0, maxChanges),
    omittedCount: deleteItems.length - maxChanges,
  };
}

export function resolveLocalFilePath(sourceRoot: string, archivePath: string): string {
  const resolvedRoot = path.resolve(sourceRoot);
  const resolvedFile = path.resolve(resolvedRoot, ...archivePath.split("/"));
  const relative = path.relative(resolvedRoot, resolvedFile);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Local path escapes source root: ${archivePath}`);
  }

  return resolvedFile;
}
