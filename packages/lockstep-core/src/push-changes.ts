import { stat } from "node:fs/promises";
import type { MediaItem } from "@latch-works/media-domain";
import { type ArchiveFileFingerprint, fingerprintsMatch } from "@latch-works/media-index";
import { formatBytes, formatPushError, toError } from "./format.js";
import { type HashCache, loadHashCache } from "./hash-cache.js";
import { planSync } from "./plan-sync.js";
import {
  resolveLocalFilePath,
  selectChangedItems,
  selectUploadUpdateItems,
} from "./push-helpers.js";
import {
  AcknowledgementSchema,
  type PushRemoteApi,
  remoteApi,
  SyncRunSchema,
} from "./remote-api.js";
import type { LockstepObserver, LockstepPlan, PushChangesOptions } from "./types.js";

const DEFAULT_UPLOAD_CONCURRENCY = 3;
const MIN_UPLOAD_CONCURRENCY = 1;
const MAX_UPLOAD_CONCURRENCY = 8;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function resolveUploadConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }
  if (
    !Number.isInteger(value) ||
    value < MIN_UPLOAD_CONCURRENCY ||
    value > MAX_UPLOAD_CONCURRENCY
  ) {
    throw new RangeError(
      `uploadConcurrency must be an integer between ${MIN_UPLOAD_CONCURRENCY} and ${MAX_UPLOAD_CONCURRENCY}`,
    );
  }
  return value;
}

export async function pushChanges(
  options: PushChangesOptions,
  observer?: LockstepObserver,
  remote: PushRemoteApi = remoteApi,
): Promise<{ failed: number; plan: LockstepPlan; pushed: number }> {
  const { signal } = options;
  throwIfAborted(signal);
  const uploadConcurrency = resolveUploadConcurrency(options.uploadConcurrency);

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
  const syncRun = await remote.postJson(
    options.apiUrl,
    "/api/sync/runs",
    options.apiToken,
    {
      counts: plan.counts,
      sourceRoot: plan.sourceRoot,
    },
    SyncRunSchema,
    signal,
  );

  let pushed = 0;
  let failed = 0;
  let cancelled = false;
  let abortError: unknown;

  const workItems = itemsToPush.map((item, index) => ({
    current: index + 1,
    item,
  }));

  try {
    await runBoundedQueue({
      concurrency: uploadConcurrency,
      signal,
      tasks: workItems,
      work: async ({ current, item }) => {
        if (!item.local) {
          return;
        }

        try {
          const local = await resolvePushItemHash({
            cache: hashCache,
            current,
            item: item.local,
            observer,
            remote,
            signal,
            sourceRoot: plan.sourceRoot,
            total: itemsToPush.length,
          });
          await remote.pushMediaItem({
            apiToken: options.apiToken,
            apiUrl: options.apiUrl,
            item: local,
            // Keep the existing library row when only case / jpeg↔jpg spelling differs.
            logicalPath: item.action === "update" && item.remote ? item.remote.path : local.path,
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
            abortError = error;
            throw error;
          }
          const failure = toError(error);
          failed += 1;
          observer?.onEvent({
            type: "item-failure",
            action: item.action,
            current,
            error: formatPushError(failure),
            path: item.path,
            total: itemsToPush.length,
          });
        }
      },
    });
  } catch (error) {
    if (signal?.aborted) {
      cancelled = true;
      abortError = abortError ?? error;
    } else {
      throw error;
    }
  } finally {
    const wasCancelled = cancelled || (signal?.aborted ?? false);
    await remote
      .postJson(
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
        AcknowledgementSchema,
      )
      .catch((error) => {
        const failure = toError(error);
        observer?.onEvent({
          type: "status",
          message: `Warning: failed to finalize sync run: ${formatPushError(failure)}`,
        });
      });
    await hashCache.save().catch((error) => {
      const failure = toError(error);
      observer?.onEvent({
        type: "status",
        message: `Warning: hash cache could not be saved: ${formatPushError(failure)}`,
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
    throw abortError ?? signal?.reason ?? new DOMException("Aborted", "AbortError");
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

async function runBoundedQueue<T>({
  concurrency,
  signal,
  tasks,
  work,
}: {
  concurrency: number;
  signal?: AbortSignal;
  tasks: T[];
  work: (task: T) => Promise<void>;
}): Promise<void> {
  let nextIndex = 0;
  let active = 0;
  let settled = false;
  let firstError: Error | undefined;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const settleIfDone = (): void => {
      if (settled) {
        return;
      }
      if (active === 0 && (nextIndex >= tasks.length || signal?.aborted)) {
        settled = true;
        if (signal?.aborted) {
          reject(firstError ?? signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        resolve();
      }
    };

    const schedule = (): void => {
      if (settled) {
        return;
      }

      if (signal?.aborted) {
        settleIfDone();
        return;
      }

      while (active < concurrency && nextIndex < tasks.length) {
        if (signal?.aborted) {
          break;
        }

        const task = tasks[nextIndex++];
        if (task === undefined) {
          break;
        }

        active += 1;
        void work(task)
          .catch((error) => {
            const failure = toError(error);
            if (signal?.aborted) {
              firstError = firstError ?? failure;
            } else if (!settled) {
              // Unexpected non-abort failures from the worker wrapper should fail the queue.
              // Per-item failures are handled inside `work` and should not reject.
              firstError = firstError ?? failure;
              fail(failure);
            }
          })
          .finally(() => {
            active -= 1;
            if (settled) {
              return;
            }
            if (signal?.aborted) {
              settleIfDone();
              return;
            }
            schedule();
            settleIfDone();
          });
      }

      settleIfDone();
    };

    if (tasks.length === 0) {
      resolve();
      return;
    }

    schedule();
  });
}

async function resolvePushItemHash({
  cache,
  current,
  item,
  observer,
  remote,
  signal,
  sourceRoot,
  total,
}: {
  cache: HashCache;
  current: number;
  item: MediaItem;
  observer?: LockstepObserver;
  remote: PushRemoteApi;
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
    sha256 = await remote.hashLocalFile(
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
