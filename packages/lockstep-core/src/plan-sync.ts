import { createSyncPlan, scanArchive } from "@latch-works/media-index";
import { fetchRemoteSnapshot, readRemoteSnapshot } from "./remote-snapshot.js";
import { resolveHashFiles } from "./push-helpers.js";
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
    observer?.onEvent({ type: "status", message: `Loading remote snapshot from ${options.remoteSnapshotPath}...` });
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
    message: willHash ? "Indexing and hashing local archive..." : "Indexing local archive...",
  });

  const progressCoalescer = createScanProgressCoalescer({
    emit: (progress) => observer?.onEvent({ type: "scan-progress", progress }),
  });

  let scan: Awaited<ReturnType<typeof scanArchive>>;
  try {
    scan = await scanArchive({
      hashFiles: willHash,
      onProgress: progressCoalescer.onProgress,
      signal,
      sourceRoot: options.sourceRoot,
    });
    progressCoalescer.flush();
  } finally {
    progressCoalescer.dispose();
  }

  throwIfAborted(signal);

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
