import { z } from "zod";

import type { CatalogDatabase, SqlParams } from "../catalog/database.js";
import { type FileId, type RootId, RootIdSchema } from "../contract.js";
import type { MediaToolkit } from "../media/toolkit.js";

/** What every analysis pass runs with. */
export interface PassContext {
  db: CatalogDatabase;
  toolkit: MediaToolkit;
  /** The root to analyse, or null for every root. */
  rootId: RootId | null;
  signal: AbortSignal;
  /**
   * Waits while the job is paused and throws once it is cancelled; call between items. A
   * background job may run foreground jobs inside it, once `settle` says its own items are done.
   */
  checkpoint: (settle?: () => Promise<void>) => Promise<void>;
  progress: (update: { done: number; total: number; label: string }) => void;
}

export function rootClause(context: PassContext, params: SqlParams): string {
  if (context.rootId === null) {
    return "";
  }

  params.$root = context.rootId;

  return "AND f.root_id = $root";
}

/**
 * Runs `work` over `items`, at most `concurrency` at a time, checking the job between items. The
 * checkpoint can wait for every item in flight to finish, so whatever it runs never overlaps them.
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  checkpoint: (settle?: () => Promise<void>) => Promise<void>,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let inFlight = 0;
  let idle: (() => void) | null = null;

  const settle = () =>
    inFlight === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          idle = resolve;
        });

  const lane = async () => {
    for (let index = next++; index < items.length; index = next++) {
      await checkpoint(settle);
      const item = items[index];

      if (item === undefined) {
        continue;
      }

      inFlight += 1;

      try {
        await work(item, index);
      } finally {
        inFlight -= 1;

        if (inFlight === 0) {
          idle?.();
          idle = null;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
}

/** A row as a pass selected it; the pass works on it only while the catalog still agrees. */
export interface SelectedFile {
  id: FileId;
  root_id: RootId;
  rel_path: string;
  size: number;
  mtime_ms: number;
}

const CurrentRowSchema = z.object({
  root_id: RootIdSchema,
  rel_path: z.string(),
  size: z.number(),
  mtime_ms: z.number(),
});

/**
 * True when the file's row still has the path, size and mtime the pass selected it with. A
 * background pass can resume after a foreground job moved, held or converted the file.
 */
export function stillSelected(context: PassContext, file: SelectedFile): boolean {
  const current = context.db.get(
    "SELECT root_id, rel_path, size, mtime_ms FROM files WHERE id = $id",
    CurrentRowSchema,
    { $id: file.id },
  );

  return (
    current !== null &&
    current.root_id === file.root_id &&
    current.rel_path === file.rel_path &&
    current.size === file.size &&
    current.mtime_ms === file.mtime_ms
  );
}

/** The WHERE condition that writes a pass's result only to the row it selected, unchanged. */
export const SAME_ROW_SQL = `id = $id AND root_id = $root_id AND rel_path = $rel_path
  AND size = $size AND mtime_ms = $mtime_ms`;

export function sameRowParams(file: SelectedFile): SqlParams {
  return {
    $id: file.id,
    $root_id: file.root_id,
    $rel_path: file.rel_path,
    $size: file.size,
    $mtime_ms: file.mtime_ms,
  };
}
