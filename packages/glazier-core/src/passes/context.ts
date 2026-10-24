import type { CatalogDatabase, SqlParams } from "../catalog/database.js";
import type { RootId } from "../contract.js";
import type { MediaToolkit } from "../media/toolkit.js";

/** What every analysis pass runs with. */
export interface PassContext {
  db: CatalogDatabase;
  toolkit: MediaToolkit;
  /** The root to analyse, or null for every root. */
  rootId: RootId | null;
  signal: AbortSignal;
  /** Waits while the job is paused and throws once it is cancelled; call between items. */
  checkpoint: () => Promise<void>;
  progress: (update: { done: number; total: number; label: string }) => void;
}

export function rootClause(context: PassContext, params: SqlParams): string {
  if (context.rootId === null) {
    return "";
  }

  params.$root = context.rootId;

  return "AND f.root_id = $root";
}

/** Runs `work` over `items`, at most `concurrency` at a time, checking the job between items. */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  checkpoint: () => Promise<void>,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;

  const lane = async () => {
    for (let index = next++; index < items.length; index = next++) {
      await checkpoint();
      const item = items[index];

      if (item !== undefined) {
        await work(item, index);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
}
