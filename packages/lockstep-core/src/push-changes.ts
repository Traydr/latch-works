import { formatPushError } from "./format.js";
import { planSync } from "./plan-sync.js";
import {
  selectChangedItems,
  selectUploadUpdateItems,
} from "./push-helpers.js";
import { postJson, pushMediaItem } from "./remote-api.js";
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
        hashFiles: options.hashFiles ?? true,
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

  try {
    for (const [index, item] of itemsToPush.entries()) {
      throwIfAborted(signal);

      const current = index + 1;
      try {
        if (!item.local) {
          continue;
        }

        await pushMediaItem({
          apiToken: options.apiToken,
          apiUrl: options.apiUrl,
          item: item.local,
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
  } finally {
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
        error: failed > 0 ? `${failed} item(s) failed during push` : undefined,
        status: failed > 0 ? "failed" : "completed",
      },
      signal,
    ).catch((error) => {
      observer?.onEvent({
        type: "status",
        message: `Warning: failed to finalize sync run: ${formatPushError(error)}`,
      });
    });
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
