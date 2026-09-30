import { lstat, stat } from "node:fs/promises";
import { DirectoryAliasIndex, MissingPathErrorSchema } from "./directory-alias-index.js";
import { formatPushError, toError } from "./format.js";
import { resolveLocalFilePath, selectChangedItems, selectDeleteItems } from "./push-helpers.js";
import {
  createSyncRun,
  failUnfinalizedRun,
  finalizeSyncRun,
  type PruneRemoteApi,
  remoteApi,
} from "./remote-api.js";
import type { LockstepObserver, LockstepPlan, PruneDeletedOptions } from "./types.js";

/** Why a planned delete was left alone; shown next to the path in progress output. */
const BACK_IN_SOURCE_REASON = "the file is back in the source folder";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

/**
 * A planned delete is only safe while the file is still missing locally. Anything at the path
 * (file, folder, or link) means it came back after the plan, and so does a new file under a
 * spelling planning treats as the same entry (case, Unicode, jpeg↔jpg). An equivalent file the
 * plan already accounts for, such as the `.jpg` twin of a deleted `.jpeg`, does not count. Errors
 * other than "missing" throw so the entry counts as failed rather than deleted.
 */
async function isAbsentLocally(
  sourceRoot: string,
  archivePath: string,
  plannedLocalPaths: ReadonlySet<string>,
  aliasIndex: DirectoryAliasIndex,
): Promise<boolean> {
  try {
    await lstat(resolveLocalFilePath(sourceRoot, archivePath));

    return false;
  } catch (error) {
    if (!MissingPathErrorSchema.safeParse(error).success) {
      throw error;
    }
  }

  const equivalents = await aliasIndex.findEquivalentPaths(archivePath);

  return equivalents.every((localPath) => plannedLocalPaths.has(localPath));
}

/** Which directory the source folder is, so a moved or remounted folder is noticed. */
interface SourceRootIdentity {
  dev: number;
  ino: number;
}

/** Stops the whole prune: without the reviewed source folder no absence can be trusted. */
class SourceRootUnavailableError extends Error {
  constructor(sourceRoot: string) {
    super(
      `Source folder is not available: ${sourceRoot}. Prune needs it to confirm each file is still gone.`,
    );
    this.name = "SourceRootUnavailableError";
  }
}

/** An unmounted drive would make every file look absent; refuse to prune against it. */
async function assertSourceRootAvailable(sourceRoot: string): Promise<SourceRootIdentity> {
  const rootStat = await stat(sourceRoot).catch(() => null);

  if (!rootStat?.isDirectory()) {
    throw new SourceRootUnavailableError(sourceRoot);
  }

  return { dev: rootStat.dev, ino: rootStat.ino };
}

/**
 * Checked after a file looks absent and before its delete: the folder must still be the one
 * prune started with, not gone, moved, or an empty mountpoint left by an unplugged drive.
 */
async function assertSourceRootUnchanged(
  sourceRoot: string,
  expected: SourceRootIdentity,
): Promise<void> {
  const current = await assertSourceRootAvailable(sourceRoot);

  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new SourceRootUnavailableError(sourceRoot);
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

  const plannedLocalPaths = new Set(
    plan.items.filter((item) => item.action !== "delete").map((item) => item.path),
  );

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

  const sourceRootIdentity = await assertSourceRootAvailable(plan.sourceRoot);
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

  // A cancel does not abort creation (see createSyncRun); it skips all item work (the loop below
  // checks the signal first) and finalizes this run as cancelled.
  const syncRun = await createSyncRun({
    apiToken: options.apiToken,
    apiUrl: options.apiUrl,
    body: { counts: plan.counts, sourceRoot: plan.sourceRoot },
    postJson: remote.postJson,
    signal,
  });

  const aliasIndex = new DirectoryAliasIndex(plan.sourceRoot);
  let pruned = 0;
  let skipped = 0;
  let failed = 0;
  let abortError: unknown;
  let runError: Error | undefined;

  try {
    for (const [index, item] of itemsToPrune.entries()) {
      throwIfAborted(signal);

      const current = index + 1;

      try {
        if (!(await isAbsentLocally(plan.sourceRoot, item.path, plannedLocalPaths, aliasIndex))) {
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

        await assertSourceRootUnchanged(plan.sourceRoot, sourceRootIdentity);
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
        if (signal?.aborted || error instanceof SourceRootUnavailableError) {
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
      abortError = error;
    } else {
      runError = toError(error);
    }
  }

  // Decided once, after the loop: the server and the caller must agree on how the run ended.
  const cancelled = signal?.aborted ?? false;

  const finalizeError = await finalizeSyncRun({
    apiToken: options.apiToken,
    apiUrl: options.apiUrl,
    body: {
      counts: {
        ...plan.counts,
        capped: itemsToPrune.length,
        failed,
        planned: changedItems.length,
        pushed: pruned,
      },
      error: cancelled
        ? "Run cancelled by user"
        : runError
          ? runError.message
          : failed > 0
            ? `${failed} delete(s) failed during prune`
            : undefined,
      status: cancelled ? "cancelled" : runError || failed > 0 ? "failed" : "completed",
    },
    onRetry: (error) => {
      observer?.onEvent({
        type: "status",
        message: `Warning: failed to finalize sync run, retrying: ${formatPushError(error)}`,
      });
    },
    postJson: remote.postJson,
    syncRunId: syncRun.syncRunId,
  });

  const abortReason = abortError ?? signal?.reason ?? new DOMException("Aborted", "AbortError");

  // An unfinalized run outranks cancellation and fatal errors: it is the one the user must act on.
  if (finalizeError) {
    observer?.onEvent({
      type: "status",
      message: `Warning: failed to finalize sync run: ${formatPushError(finalizeError)}`,
    });

    throw failUnfinalizedRun({
      action: "prune",
      done: `${pruned} delete(s) applied`,
      failed,
      finalizeError,
      interruption: cancelled
        ? { reason: abortReason, status: "cancelled" }
        : runError
          ? { error: runError, status: "failed" }
          : undefined,
      observer,
      planCounts: plan.counts,
      pushed: pruned,
      skipped,
      syncRunId: syncRun.syncRunId,
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
    throw abortReason;
  }

  if (runError) {
    throw runError;
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
