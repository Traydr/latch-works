import { stat } from "node:fs/promises";
import type { MediaItem } from "@latch-works/media-domain";
import { formatError, throwIfAborted, toError } from "./errors.js";
import { type HashCache, loadHashCache } from "./hash-cache.js";
import {
  plannedChanges,
  plannedUploads,
  resolveLocalFilePath,
  resolveUploadConcurrency,
} from "./push-helpers.js";
import { type HashedMediaItem, hashLocalFile, pushMediaItem } from "./remote-api.js";
import type { ArchiveFileFingerprint } from "./scan.js";
import { SyncRun } from "./sync-run.js";
import type { LockstepObserver, PushChangesOptions, PushStage, RunSummary } from "./types.js";

/** Uploads and updates the reviewed plan's changes, capped by `maxChanges`; never deletes. */
export async function pushChanges(
  options: PushChangesOptions,
  observer?: LockstepObserver,
): Promise<RunSummary> {
  const { plan, signal } = options;
  throwIfAborted(signal);
  const uploadConcurrency = resolveUploadConcurrency(options.uploadConcurrency);
  const changedItems = plannedChanges(plan);
  const { items: itemsToPush, omittedCount } = plannedUploads(plan, options.maxChanges);

  if (itemsToPush.length === 0) {
    return { action: "push", applied: 0, failed: 0, skipped: 0, status: "completed" };
  }

  observer?.onEvent({
    type: "status",
    message:
      omittedCount > 0
        ? `Pushing ${itemsToPush.length} of ${changedItems.length} changes (capped by max-changes).`
        : `Pushing ${itemsToPush.length} upload/update change(s).`,
  });

  const { cache: hashCache, warning: cacheWarning } = await loadHashCache({
    cacheRoot: options.hashCacheRoot,
    sourceRoot: plan.sourceRoot,
  });

  if (cacheWarning) {
    observer?.onEvent({ type: "warning", message: cacheWarning });
  }

  const api = { apiToken: options.apiToken, apiUrl: options.apiUrl };

  const run = await SyncRun.open({
    action: "push",
    api,
    observer,
    plan,
    signal,
  });

  const outcome = await run.apply(itemsToPush, uploadConcurrency, async (item, report) => {
    if (!item.local) {
      throw new Error(`The plan has no local file for ${item.path}.`);
    }

    const local = await hashPushItem({
      cache: hashCache,
      item: item.local,
      report,
      signal,
      sourceRoot: plan.sourceRoot,
    });

    await pushMediaItem({
      api,
      item: local,
      // Keep the existing library row when only case / jpeg↔jpg spelling differs.
      logicalPath: item.action === "update" && item.remote ? item.remote.path : local.path,
      onStage: report,
      signal,
      sourceRoot: plan.sourceRoot,
      syncRunId: run.syncRunId,
    });

    return { kind: "applied" };
  });

  await hashCache.save().catch((error) => {
    observer?.onEvent({
      type: "warning",
      message: `hash cache could not be saved: ${formatError(toError(error))}`,
    });
  });

  return run.finish(outcome);
}

/**
 * The item with its content hash, from the cache when the file is unchanged since planning. A file
 * that changed after planning, or while it is hashed, fails the item.
 */
async function hashPushItem({
  cache,
  item,
  report,
  signal,
  sourceRoot,
}: {
  cache: HashCache;
  item: MediaItem;
  report: (stage: PushStage, bytes?: { done: number; total: number }) => void;
  signal?: AbortSignal;
  sourceRoot: string;
}): Promise<HashedMediaItem> {
  const filePath = resolveLocalFilePath(sourceRoot, item.path);
  const fileStat = await stat(filePath);

  const fingerprint: ArchiveFileFingerprint = {
    ctimeMs: fileStat.ctimeMs,
    mtimeMs: Math.trunc(fileStat.mtimeMs),
    size: fileStat.size,
  };

  if (fingerprint.size !== item.size || fingerprint.mtimeMs !== Math.trunc(item.mtimeMs)) {
    throw new Error(`Local file changed after planning; rerun sync: ${item.path}`);
  }

  let sha256 = cache.get(item.path, fingerprint);

  if (!sha256) {
    report("hashing");
    sha256 = await hashLocalFile(
      filePath,
      fingerprint,
      (done) => report("hashing", { done, total: fingerprint.size }),
      signal,
    );
    cache.set(item.path, fingerprint, sha256);
  }

  return { ...item, id: sha256, sha256 };
}
