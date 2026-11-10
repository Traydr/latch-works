import { lstat, stat } from "node:fs/promises";
import { DirectoryAliasIndex } from "./directory-alias-index.js";
import { isMissingPathError, throwIfAborted } from "./errors.js";
import { plannedDeletes, resolveLocalFilePath } from "./push-helpers.js";
import { deleteRemoteItem } from "./remote-api.js";
import { FatalRunError, SyncRun } from "./sync-run.js";
import type { LockstepObserver, PruneDeletedOptions, RunSummary } from "./types.js";

/** Why a planned delete was left alone; shown next to the path in progress output. */
const BACK_IN_SOURCE_REASON = "the file is back in the source folder";

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
    if (!isMissingPathError(error)) {
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
class SourceRootUnavailableError extends FatalRunError {
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
): Promise<RunSummary> {
  const { plan, signal } = options;
  throwIfAborted(signal);

  const plannedLocalPaths = new Set(
    plan.items.filter((item) => item.action !== "delete").map((item) => item.path),
  );

  const { items: itemsToPrune, omittedCount } = plannedDeletes(plan, options.maxChanges);

  if (itemsToPrune.length === 0) {
    return { action: "prune", applied: 0, failed: 0, skipped: 0, status: "completed" };
  }

  const sourceRootIdentity = await assertSourceRootAvailable(plan.sourceRoot);
  throwIfAborted(signal);

  observer?.onEvent({
    type: "status",
    message:
      omittedCount > 0
        ? `Pruning ${itemsToPrune.length} of ${plan.counts.delete} delete(s) (capped by max-changes).`
        : `Applying ${itemsToPrune.length} remote delete(s).`,
  });

  const api = { apiToken: options.apiToken, apiUrl: options.apiUrl };

  const run = await SyncRun.open({
    action: "prune",
    api,
    observer,
    plan,
    signal,
  });

  const aliasIndex = new DirectoryAliasIndex(plan.sourceRoot);

  const outcome = await run.apply(itemsToPrune, 1, async (item, report) => {
    if (!(await isAbsentLocally(plan.sourceRoot, item.path, plannedLocalPaths, aliasIndex))) {
      return { kind: "skipped", reason: BACK_IN_SOURCE_REASON };
    }

    await assertSourceRootUnchanged(plan.sourceRoot, sourceRootIdentity);
    report("deleting");
    await deleteRemoteItem({
      api,
      logicalPath: item.path,
      signal,
      syncRunId: run.syncRunId,
    });

    return { kind: "applied" };
  });

  return run.finish(outcome);
}
