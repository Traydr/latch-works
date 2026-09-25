import { lstat, stat } from "node:fs/promises";
import { z } from "zod";
import { formatPushError, toError } from "./format.js";
import { resolveLocalFilePath, selectChangedItems, selectDeleteItems } from "./push-helpers.js";
import {
  AcknowledgementSchema,
  type PruneRemoteApi,
  remoteApi,
  SyncRunSchema,
} from "./remote-api.js";
import type { LockstepObserver, LockstepPlan, PruneDeletedOptions } from "./types.js";

/** Why a planned delete was left alone; shown next to the path in progress output. */
const BACK_IN_SOURCE_REASON = "the file is back in the source folder";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

/** The fs error codes that mean nothing exists at a path. */
const MissingPathErrorSchema = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });

/**
 * A planned delete is only safe while the file is still missing locally. Anything at the path
 * (file, folder, or link) means it came back after the plan; errors other than "missing" throw so
 * the entry counts as failed rather than deleted.
 */
async function isAbsentLocally(sourceRoot: string, archivePath: string): Promise<boolean> {
  try {
    await lstat(resolveLocalFilePath(sourceRoot, archivePath));

    return false;
  } catch (error) {
    if (MissingPathErrorSchema.safeParse(error).success) {
      return true;
    }

    throw error;
  }
}

/** An unmounted drive would make every file look absent; refuse to prune against it. */
async function assertSourceRootAvailable(sourceRoot: string): Promise<void> {
  const rootStat = await stat(sourceRoot).catch(() => null);

  if (!rootStat?.isDirectory()) {
    throw new Error(
      `Source folder is not available: ${sourceRoot}. Prune needs it to confirm each file is still gone.`,
    );
  }
}

/**
 * Deletes the remote entries the reviewed plan lists as deletes, capped by `maxChanges`. It never
 * plans again: an entry is skipped when its file is back in the source folder, and nothing outside
 * the plan is touched.
 */
export async function pruneDeleted(
  options: PruneDeletedOptions,
  observer?: LockstepObserver,
  remote: PruneRemoteApi = remoteApi,
): Promise<{ failed: number; plan: LockstepPlan; pruned: number; skipped: number }> {
  const { plan, signal } = options;
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

    return { failed: 0, plan, pruned: 0, skipped: 0 };
  }

  await assertSourceRootAvailable(plan.sourceRoot);
  throwIfAborted(signal);

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

  let pruned = 0;
  let skipped = 0;
  let failed = 0;
  let cancelled = false;

  try {
    for (const [index, item] of itemsToPrune.entries()) {
      throwIfAborted(signal);

      const current = index + 1;

      try {
        if (!(await isAbsentLocally(plan.sourceRoot, item.path))) {
          skipped += 1;
          observer?.onEvent({
            type: "item-skipped",
            action: "delete",
            current,
            path: item.path,
            reason: BACK_IN_SOURCE_REASON,
            total: itemsToPrune.length,
          });

          continue;
        }

        observer?.onEvent({
          type: "status",
          message: `[${current}/${itemsToPrune.length}] deleting ${item.path}`,
        });
        await remote.deleteRemoteItem({
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

        const failure = toError(error);
        failed += 1;
        observer?.onEvent({
          type: "item-failure",
          action: "delete",
          current,
          error: formatPushError(failure),
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
    await remote
      .postJson(
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
        AcknowledgementSchema,
      )
      .catch((error) => {
        const failure = toError(error);
        observer?.onEvent({
          type: "status",
          message: `Warning: failed to finalize sync run: ${formatPushError(failure)}`,
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
        skipped,
        status: "cancelled",
      },
    });
    throw signal?.reason ?? new DOMException("Aborted", "AbortError");
  }

  const summary = {
    action: "prune" as const,
    completedAt: new Date().toISOString(),
    failed,
    message:
      skipped > 0 ? `${skipped} delete(s) skipped because ${BACK_IN_SOURCE_REASON}.` : undefined,
    planCounts: plan.counts,
    pushed: pruned,
    skipped,
    status: failed > 0 ? ("failed" as const) : ("completed" as const),
  };

  observer?.onEvent({ type: "complete", summary });

  return { failed, plan, pruned, skipped };
}
