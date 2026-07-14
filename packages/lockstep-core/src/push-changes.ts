import { stat } from "node:fs/promises";
import type { MediaItem } from "@latch-works/media-domain";
import { type ArchiveFileFingerprint, fingerprintsMatch } from "@latch-works/media-index";
import { formatBytes, formatPushError } from "./format.js";
import { type HashCache, loadHashCache } from "./hash-cache.js";
import { planSync } from "./plan-sync.js";
import {
  resolveLocalFilePath,
  selectChangedItems,
  selectUploadUpdateItems,
} from "./push-helpers.js";
import { hashLocalFile, postJson, pushMediaItem } from "./remote-api.js";
import type { LockstepObserver, LockstepPlan, PushChangesOptions } from "./types.js";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

export async function pushChanges(
  options: PushChangesOptions,
  observer?: LockstepObserver,
): Promise<{ failed: number; plan: LockstepPlan; pushed: number }> {
  const { signal } = options;
  throwIfAborted(signal);

  const plan =
    options.plan ??
    (await planSync(
      {
        apiToken: options.apiToken,
        apiUrl: options.apiUrl,
        hashCacheRoot: options.hashCacheRoot,
        hashFiles: options.hashFiles ?? true,
        hashMode:
          options.hashMode ?? (options.hashFiles === undefined ? "remote-aware" : undefined),
        remoteSnapshotPath: options.remoteSnapshotPath,
        signal,
        sourceRoot: options.sourceRoot,
      },
      observer,
    ));

  throwIfAborted(signal);

  const changedItems = selectChangedItems(plan.items);
  const { items: itemsToPush, omittedCount } = selectUploadUpdateItems(
    changedItems,
    options.maxChanges,
  );

  if (itemsToPush.length === 0) {
    observer?.onEvent({
      type: "complete",
      summary: {
        action: "push",
        completedAt: new Date().toISOString(),
        failed: 0,
        message: "Nothing to push.",
        planCounts: plan.counts,
        pushed: 0,
        status: "completed",
      },
    });
    return { failed: 0, plan, pushed: 0 };
  }

  if (omittedCount > 0) {
    observer?.onEvent({
      type: "status",
      message: `Pushing ${itemsToPush.length} of ${changedItems.length} changes (capped by max-changes).`,
    });
  } else {
    observer?.onEvent({
      type: "status",
      message: `Pushing ${itemsToPush.length} upload/update change(s).`,
    });
  }

  const { cache: hashCache, warning: cacheWarning } = await loadHashCache({
    cacheRoot: options.hashCacheRoot,
    sourceRoot: plan.sourceRoot,
  });
  if (cacheWarning) {
    observer?.onEvent({ type: "status", message: `Warning: ${cacheWarning}` });
  }

  observer?.onEvent({ type: "status", message: "Creating sync run..." });
  const syncRun = await postJson<{ syncRunId: string }>(
    options.apiUrl,
    "/api/sync/runs",
    options.apiToken,
    {
      counts: plan.counts,
      sourceRoot: plan.sourceRoot,
    },
    signal,
  );

  let pushed = 0;
  let failed = 0;
  let cancelled = false;

  try {
    for (const [index, item] of itemsToPush.entries()) {
      throwIfAborted(signal);

      const current = index + 1;
      try {
        if (!item.local) {
          continue;
        }

        const local = await resolvePushItemHash({
          cache: hashCache,
          current,
          item: item.local,
          observer,
          signal,
          sourceRoot: plan.sourceRoot,
          total: itemsToPush.length,
        });
        await pushMediaItem({
          apiToken: options.apiToken,
          apiUrl: options.apiUrl,
          item: local,
          onStage: (stage, detail) => {
            observer?.onEvent({
              type: "status",
              message: `[${current}/${itemsToPush.length}] ${stage} ${item.path}${detail ? ` (${detail})` : ""}`,
            });
          },
          signal,
          sourceRoot: plan.sourceRoot,
          syncRunId: syncRun.syncRunId,
        });
        pushed += 1;
        observer?.onEvent({
          type: "item-success",
          action: item.action,
          current,
          path: item.path,
          total: itemsToPush.length,
        });
      } catch (error) {
        if (signal?.aborted) {
          cancelled = true;
          throw error;
        }
        failed += 1;
        observer?.onEvent({
          type: "item-failure",
          action: item.action,
          current,
          error: formatPushError(error),
          path: item.path,
          total: itemsToPush.length,
        });
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      cancelled = true;
    } else {
      throw error;
    }
  } finally {
    const wasCancelled = cancelled || (signal?.aborted ?? false);
    await postJson(
      options.apiUrl,
      `/api/sync/runs/${syncRun.syncRunId}/complete`,
      options.apiToken,
      {
        counts: {
          ...plan.counts,
          capped: itemsToPush.length,
          failed,
          planned: changedItems.length,
          pushed,
        },
        error: wasCancelled
          ? "Run cancelled by user"
          : failed > 0
            ? `${failed} item(s) failed during push`
            : undefined,
        status: wasCancelled ? "cancelled" : failed > 0 ? "failed" : "completed",
      },
    ).catch((error) => {
      observer?.onEvent({
        type: "status",
        message: `Warning: failed to finalize sync run: ${formatPushError(error)}`,
      });
    });
    await hashCache.save().catch((error) => {
      observer?.onEvent({
        type: "status",
        message: `Warning: hash cache could not be saved: ${formatPushError(error)}`,
      });
    });
  }

  if (cancelled) {
    observer?.onEvent({
      type: "complete",
      summary: {
        action: "push",
        completedAt: new Date().toISOString(),
        failed,
        planCounts: plan.counts,
        pushed,
        status: "cancelled",
      },
    });
    throw signal?.reason ?? new DOMException("Aborted", "AbortError");
  }

  const summary = {
    action: "push" as const,
    completedAt: new Date().toISOString(),
    failed,
    planCounts: plan.counts,
    pushed,
    status: failed > 0 ? ("failed" as const) : ("completed" as const),
  };

  observer?.onEvent({ type: "complete", summary });
  return { failed, plan, pushed };
}

async function resolvePushItemHash({
  cache,
  current,
  item,
  observer,
  signal,
  sourceRoot,
  total,
}: {
  cache: HashCache;
  current: number;
  item: MediaItem;
  observer?: LockstepObserver;
  signal?: AbortSignal;
  sourceRoot: string;
  total: number;
}): Promise<MediaItem> {
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
    observer?.onEvent({
      type: "status",
      message: `[${current}/${total}] hashing ${item.path}`,
    });
    sha256 = await hashLocalFile(
      filePath,
      (bytesHashed, fileSize) => {
        observer?.onEvent({
          type: "status",
          message: `[${current}/${total}] hashing ${item.path} (${formatBytes(bytesHashed)} / ${formatBytes(fileSize)})`,
        });
      },
      signal,
    );
    const afterStat = await stat(filePath);
    const afterFingerprint: ArchiveFileFingerprint = {
      ctimeMs: afterStat.ctimeMs,
      mtimeMs: Math.trunc(afterStat.mtimeMs),
      size: afterStat.size,
    };
    if (!fingerprintsMatch(fingerprint, afterFingerprint)) {
      throw new Error(`Local file changed after planning; rerun sync: ${item.path}`);
    }
    cache.set(item.path, fingerprint, sha256);
  }

  return { ...item, id: sha256, sha256 };
}
