import path from "node:path";
import type { CliOptions } from "./types.js";

export function resolveHashFiles(
  options: Pick<CliOptions, "command" | "hashFiles">,
): boolean {
  return options.hashFiles || options.command === "push";
}

export function selectChangedItemsForPush<T extends { action: string }>(
  changedItems: T[],
  maxChanges?: number,
): { items: T[]; omittedDeleteCount: number } {
  if (!maxChanges || changedItems.length <= maxChanges) {
    return { items: changedItems, omittedDeleteCount: 0 };
  }

  const items = changedItems.slice(0, maxChanges);
  const omittedDeletes = changedItems.slice(maxChanges).filter((item) => item.action === "delete");
  return { items, omittedDeleteCount: omittedDeletes.length };
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
