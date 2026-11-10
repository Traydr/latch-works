import { type MediaItem, pairSyncPaths } from "@latch-works/media-domain";
import type { RemoteEntry } from "@latch-works/sync-protocol";
import { throwIfAborted, toError } from "./errors.js";
import { loadHashCache } from "./hash-cache.js";
import { fetchRemoteSnapshot, readRemoteSnapshot } from "./remote-snapshot.js";
import { hashArchiveItems, scanArchive } from "./scan.js";
import { createSyncPlan } from "./sync-plan.js";
import type { LockstepObserver, LockstepPlan, PlanSyncOptions, SnapshotSource } from "./types.js";

async function loadRemote(
  remote: SnapshotSource,
  observer: LockstepObserver | undefined,
  signal: AbortSignal | undefined,
): Promise<RemoteEntry[]> {
  if (remote.kind === "none") {
    return [];
  }

  observer?.onEvent({
    type: "status",
    message:
      remote.kind === "file"
        ? `Loading remote snapshot from ${remote.path}...`
        : "Fetching remote sync snapshot...",
  });

  const entries =
    remote.kind === "file"
      ? await readRemoteSnapshot(remote.path)
      : await fetchRemoteSnapshot(remote, signal);

  observer?.onEvent({
    type: "status",
    message: `Remote snapshot loaded (${entries.length.toLocaleString()} entries).`,
  });

  return entries;
}

export async function planSync(
  options: PlanSyncOptions,
  observer?: LockstepObserver,
): Promise<LockstepPlan> {
  const { hashMode, signal } = options;
  throwIfAborted(signal);

  const remote = await loadRemote(options.remote, observer, signal);
  throwIfAborted(signal);
  observer?.onEvent({ type: "status", message: "Indexing local archive..." });

  const reportProgress: Parameters<typeof scanArchive>[0]["onProgress"] = (progress) =>
    observer?.onEvent({ type: "scan-progress", progress });

  const scan = await scanArchive({
    onProgress: reportProgress,
    signal,
    sourceRoot: options.sourceRoot,
  });

  let localItems = scan.items;

  if (hashMode !== "none") {
    const { cache, warning } = await loadHashCache({
      cacheRoot: options.hashCacheRoot,
      sourceRoot: scan.sourceRoot,
    });

    if (warning) {
      observer?.onEvent({ type: "warning", message: warning });
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
        fingerprints: scan.fingerprints,
        items: localItems,
        onProgress: reportProgress,
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
        type: "warning",
        message: `hash cache could not be saved: ${toError(error).message}`,
      });
    });
  }

  throwIfAborted(signal);

  return {
    ...createSyncPlan(localItems, remote),
    skippedEntries: scan.skippedEntries,
    sourceRoot: scan.sourceRoot,
    totalBytes: localItems.reduce((sum, item) => sum + item.size, 0),
    totalFiles: localItems.length,
  };
}

/**
 * The files a plan hashes: every unhashed one for `all`; for `remote-aware`, only those whose
 * paired remote entry has a hash and the same size, where the hash alone can tell them apart.
 */
export function selectPlanningHashPaths(
  hashMode: "all" | "remote-aware",
  localItems: readonly MediaItem[],
  remoteEntries: readonly RemoteEntry[],
): Set<string> {
  if (hashMode === "all") {
    return new Set(localItems.flatMap((item) => (item.sha256 ? [] : [item.path])));
  }

  const pairs = pairSyncPaths(
    localItems.map((item) => item.path),
    remoteEntries.map((entry) => entry.path),
  );

  const remoteByPath = new Map(remoteEntries.map((entry) => [entry.path, entry]));

  return new Set(
    localItems.flatMap((item) => {
      if (item.sha256) {
        return [];
      }

      const pairedPath = pairs.get(item.path);
      const remote = pairedPath === undefined ? undefined : remoteByPath.get(pairedPath);

      return remote?.sha256 !== undefined && remote.size === item.size ? [item.path] : [];
    }),
  );
}
