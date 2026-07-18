import { createSyncPathIdentity } from "@latch-works/media-domain";
import { createSyncPlan, hashArchiveItems, scanArchive } from "@latch-works/media-index";
import { loadHashCache } from "./hash-cache.js";
import { resolveHashMode } from "./push-helpers.js";
import { fetchRemoteSnapshot, readRemoteSnapshot } from "./remote-snapshot.js";
import { createScanProgressCoalescer } from "./scan-progress-coalescer.js";
import type { LockstepObserver, LockstepPlan, PlanSyncOptions } from "./types.js";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

export async function planSync(
  options: PlanSyncOptions,
  observer?: LockstepObserver,
): Promise<LockstepPlan> {
  const { signal } = options;
  throwIfAborted(signal);

  let remote: Awaited<ReturnType<typeof fetchRemoteSnapshot>> = [];
  if (options.remoteSnapshotPath) {
    observer?.onEvent({
      type: "status",
      message: `Loading remote snapshot from ${options.remoteSnapshotPath}...`,
    });
    remote = await readRemoteSnapshot(options.remoteSnapshotPath);
    observer?.onEvent({
      type: "status",
      message: `Remote snapshot loaded (${remote.length.toLocaleString()} entries).`,
    });
  } else if (options.apiUrl && options.apiToken) {
    observer?.onEvent({ type: "status", message: "Fetching remote sync snapshot..." });
    remote = await fetchRemoteSnapshot(options.apiUrl, options.apiToken, signal);
    observer?.onEvent({
      type: "status",
      message: `Remote snapshot loaded (${remote.length.toLocaleString()} entries).`,
    });
  }

  throwIfAborted(signal);

  const hashMode = resolveHashMode({ hashFiles: options.hashFiles, hashMode: options.hashMode });
  observer?.onEvent({
    type: "status",
    message: "Indexing local archive...",
  });

  const progressCoalescer = createScanProgressCoalescer({
    emit: (progress) => observer?.onEvent({ type: "scan-progress", progress }),
  });

  let scan: Awaited<ReturnType<typeof scanArchive>>;
  let localItems: Awaited<ReturnType<typeof scanArchive>>["items"] = [];
  try {
    scan = await scanArchive({
      directoryConcurrency: options.directoryConcurrency,
      fileConcurrency: options.fileConcurrency,
      hashFiles: false,
      onProgress: progressCoalescer.onProgress,
      signal,
      sourceRoot: options.sourceRoot,
    });
    localItems = scan.items;

    if (hashMode !== "none") {
      const { cache, warning } = await loadHashCache({
        cacheRoot: options.hashCacheRoot,
        sourceRoot: scan.sourceRoot,
      });
      if (warning) {
        observer?.onEvent({ type: "status", message: `Warning: ${warning}` });
      }

      const hydrated = cache.hydrate(localItems, scan.fingerprints);
      localItems = hydrated.items;
      const hashPaths = selectPlanningHashPaths(hashMode, localItems, remote);
      observer?.onEvent({
        type: "status",
        message: `Hash cache: ${hydrated.hits.toLocaleString()} hit(s); ${hashPaths.size.toLocaleString()} file(s) require hashing.`,
      });

      if (hashPaths.size > 0) {
        localItems = await hashArchiveItems({
          fileConcurrency: options.fileConcurrency,
          fingerprints: scan.fingerprints,
          items: localItems,
          onProgress: progressCoalescer.onProgress,
          paths: hashPaths,
          signal,
          skipped: scan.skipped,
          sourceRoot: scan.sourceRoot,
        });
      }

      cache.updateFromItems(localItems, scan.fingerprints);
      cache.retain(new Set(localItems.map((item) => item.path)));
      await cache.save().catch((error) => {
        observer?.onEvent({
          type: "status",
          message: `Warning: hash cache could not be saved: ${formatError(error)}`,
        });
      });
    }
    progressCoalescer.flush();
  } finally {
    progressCoalescer.dispose();
  }

  throwIfAborted(signal);

  const plan = createSyncPlan(localItems, remote);
  const totalBytes = localItems.reduce((sum, item) => sum + item.size, 0);

  const result: LockstepPlan = {
    counts: plan.counts,
    items: plan.items,
    skipped: scan.skipped,
    skippedEntries: scan.skippedEntries,
    sourceRoot: scan.sourceRoot,
    totalBytes,
    totalFiles: localItems.length,
  };

  observer?.onEvent({
    type: "complete",
    summary: {
      action: "plan",
      completedAt: new Date().toISOString(),
      failed: 0,
      planCounts: result.counts,
      pushed: 0,
      status: "completed",
    },
  });

  return result;
}

function selectPlanningHashPaths(
  hashMode: "all" | "remote-aware",
  localItems: Awaited<ReturnType<typeof scanArchive>>["items"],
  remoteEntries: Awaited<ReturnType<typeof fetchRemoteSnapshot>>,
): Set<string> {
  if (hashMode === "all") {
    return new Set(localItems.filter((item) => !item.sha256).map((item) => item.path));
  }

  const identity = createSyncPathIdentity(
    localItems.map((item) => item.path),
    remoteEntries.map((entry) => entry.path),
  );
  const remoteByPath = new Map(remoteEntries.map((entry) => [identity(entry.path), entry]));
  return new Set(
    localItems
      .filter((item) => {
        if (item.sha256) {
          return false;
        }
        const remote = remoteByPath.get(identity(item.path));
        return remote?.sha256 !== undefined && remote.size === item.size;
      })
      .map((item) => item.path),
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
