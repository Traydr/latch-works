import path from "node:path";
import type { SyncPlanAction } from "@latch-works/media-index";

export function resolveHashFiles(options: { hashFiles?: boolean; requireHash?: boolean }): boolean {
  return options.hashFiles === true || options.requireHash === true;
}

export function selectChangedItems<T extends { action: SyncPlanAction }>(
  items: T[],
): T[] {
  return items.filter((item) => item.action !== "keep");
}

export function selectUploadUpdateItems<T extends { action: SyncPlanAction }>(
  changedItems: T[],
  maxChanges?: number,
): { items: T[]; omittedCount: number } {
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
): { items: T[]; omittedCount: number } {
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
