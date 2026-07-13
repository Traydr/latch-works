import {
  createSyncPlan,
  scanArchive,
  scanArchiveIncremental,
  scanArchiveWithHashCache,
  type ScanArchiveResult,
} from "@latch-works/media-index";
import { resolveHashFiles } from "./push-helpers.js";
import { fetchRemoteSnapshot, readRemoteSnapshot } from "./remote-snapshot.js";
import { createScanProgressCoalescer } from "./scan-progress-coalescer.js";
import type { LockstepObserver, LockstepPlan, PlanSyncOptions } from "./types.js";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function hasRemoteSource(options: PlanSyncOptions): boolean {
  return Boolean(options.remoteSnapshotPath || (options.apiUrl && options.apiToken));
}

function formatScanSummary(scan: ScanArchiveResult & { cacheHits?: number; hashed?: number }): string {
  const parts = [`${scan.items.length.toLocaleString()} file(s) indexed`];
  if (scan.cacheHits !== undefined && scan.cacheHits > 0) {
    parts.push(`${scan.cacheHits.toLocaleString()} cache hit(s)`);
  }
  if (scan.hashed !== undefined) {
    parts.push(`${scan.hashed.toLocaleString()} hashed`);
  }
  return parts.join(", ");
}

export async function planSync(
  options: PlanSyncOptions,
  observer?: LockstepObserver,
): Promise<LockstepPlan> {
  const { signal } = options;
  throwIfAborted(signal);

  let remote: Awaited<ReturnType<typeof fetchRemoteSnapshot>> = [];
  const remoteAvailable = hasRemoteSource(options);
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

  const willHash = resolveHashFiles({ hashFiles: options.hashFiles });
  observer?.onEvent({
    type: "status",
    message: willHash
      ? remoteAvailable
        ? "Indexing local archive (incremental hash)..."
        : "Indexing local archive (cached hash)..."
      : "Indexing local archive...",
  });

  const progressCoalescer = createScanProgressCoalescer({
    emit: (progress) => observer?.onEvent({ type: "scan-progress", progress }),
  });

  const scanOptions = {
    cachePath: options.hashCachePath,
    directoryConcurrency: options.directoryConcurrency,
    fileConcurrency: options.fileConcurrency,
    onProgress: progressCoalescer.onProgress,
    signal,
    sourceRoot: options.sourceRoot,
  };

  let scan: ScanArchiveResult & { cacheHits?: number; hashed?: number };
  try {
    if (willHash && remoteAvailable) {
      const incremental = await scanArchiveIncremental({
        ...scanOptions,
        remoteEntries: remote,
      });
      scan = incremental;
    } else if (willHash) {
      const cached = await scanArchiveWithHashCache(scanOptions);
      scan = cached;
    } else {
      scan = await scanArchive({
        ...scanOptions,
        hashFiles: false,
      });
    }
    progressCoalescer.flush();
  } finally {
    progressCoalescer.dispose();
  }

  throwIfAborted(signal);

  observer?.onEvent({
    type: "status",
    message: `Local archive indexed (${formatScanSummary(scan)}).`,
  });

  const plan = createSyncPlan(scan.items, remote);
  const totalBytes = scan.items.reduce((sum, item) => sum + item.size, 0);

  const result: LockstepPlan = {
    counts: plan.counts,
    items: plan.items,
    skipped: scan.skipped,
    skippedEntries: scan.skippedEntries,
    sourceRoot: scan.sourceRoot,
    totalBytes,
    totalFiles: scan.items.length,
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
