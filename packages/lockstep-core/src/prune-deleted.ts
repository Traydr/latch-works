import { formatPushError } from "./format.js";
import { planSync } from "./plan-sync.js";
import { selectChangedItems, selectDeleteItems } from "./push-helpers.js";
import { deleteRemoteItem, postJson } from "./remote-api.js";
import type { LockstepObserver, LockstepPlan, PruneDeletedOptions } from "./types.js";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

export async function pruneDeleted(
  options: PruneDeletedOptions,
  observer?: LockstepObserver,
): Promise<{ failed: number; plan: LockstepPlan; pruned: number }> {
  const { signal } = options;
  throwIfAborted(signal);

  const plan =
    options.plan ??
    (await planSync(
      {
        apiToken: options.apiToken,
        apiUrl: options.apiUrl,
        hashFiles: options.hashFiles ?? false,
        remoteSnapshotPath: options.remoteSnapshotPath,
        signal,
        sourceRoot: options.sourceRoot,
      },
      observer,
    ));

  throwIfAborted(signal);

  const changedItems = selectChangedItems(plan.items);
  const { items: itemsToPrune, omittedCount } = selectDeleteItems(changedItems, options.maxChanges);

  if (itemsToPrune.length === 0) {
    observer?.onEvent({
      type: "complete",
      summary: {
        action: "prune",
        completedAt: new Date().toISOString(),
        failed: 0,
        message: "Nothing to prune.",
        planCounts: plan.counts,
        pushed: 0,
        status: "completed",
      },
    });
    return { failed: 0, plan, pruned: 0 };
  }

  if (omittedCount > 0) {
    observer?.onEvent({
      type: "status",
      message: `Pruning ${itemsToPrune.length} of ${plan.counts.delete} delete(s) (capped by max-changes).`,
    });
  } else {
    observer?.onEvent({
      type: "status",
      message: `Applying ${itemsToPrune.length} remote delete(s).`,
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

  let pruned = 0;
  let failed = 0;
  let cancelled = false;

  try {
    for (const [index, item] of itemsToPrune.entries()) {
      throwIfAborted(signal);

      const current = index + 1;
      try {
        observer?.onEvent({
          type: "status",
          message: `[${current}/${itemsToPrune.length}] deleting ${item.path}`,
        });
        await deleteRemoteItem({
          apiToken: options.apiToken,
          apiUrl: options.apiUrl,
          logicalPath: item.path,
          signal,
          syncRunId: syncRun.syncRunId,
        });
        pruned += 1;
        observer?.onEvent({
          type: "item-success",
          action: "delete",
          current,
          path: item.path,
          total: itemsToPrune.length,
        });
      } catch (error) {
        if (signal?.aborted) {
          cancelled = true;
          throw error;
        }
        failed += 1;
        observer?.onEvent({
          type: "item-failure",
          action: "delete",
          current,
          error: formatPushError(error),
          path: item.path,
          total: itemsToPrune.length,
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
          capped: itemsToPrune.length,
          failed,
          planned: changedItems.length,
          pushed: pruned,
        },
        error: wasCancelled
          ? "Run cancelled by user"
          : failed > 0
            ? `${failed} delete(s) failed during prune`
            : undefined,
        status: wasCancelled ? "cancelled" : failed > 0 ? "failed" : "completed",
      },
    ).catch((error) => {
      observer?.onEvent({
        type: "status",
        message: `Warning: failed to finalize sync run: ${formatPushError(error)}`,
      });
    });
  }

  if (cancelled) {
    observer?.onEvent({
      type: "complete",
      summary: {
        action: "prune",
        completedAt: new Date().toISOString(),
        failed,
        planCounts: plan.counts,
        pushed: pruned,
        status: "cancelled",
      },
    });
    throw signal?.reason ?? new DOMException("Aborted", "AbortError");
  }

  const summary = {
    action: "prune" as const,
    completedAt: new Date().toISOString(),
    failed,
    planCounts: plan.counts,
    pushed: pruned,
    status: failed > 0 ? ("failed" as const) : ("completed" as const),
  };

  observer?.onEvent({ type: "complete", summary });
  return { failed, plan, pruned };
}
