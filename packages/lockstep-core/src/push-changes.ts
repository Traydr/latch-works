import { stat } from "node:fs/promises";
import type { MediaItem } from "@latch-works/media-domain";
import { formatError, throwIfAborted, toError } from "./errors.js";
import { type HashCache, loadHashCache } from "./hash-cache.js";
import {
  type AudioProbe,
  FfprobeUnavailableError,
  mediaFactsRequests,
  probeAudioFacts,
  probeHasAudio,
  videosMissingAudioFacts,
} from "./media-facts.js";
import {
  plannedChanges,
  plannedUploads,
  resolveLocalFilePath,
  resolveUploadConcurrency,
} from "./push-helpers.js";
import {
  type HashedMediaItem,
  hashLocalFile,
  pushMediaItem,
  reportMediaFacts,
} from "./remote-api.js";
import type { ArchiveFileFingerprint } from "./scan.js";
import { SyncRun } from "./sync-run.js";
import type {
  LockstepObserver,
  PaneViewApi,
  PushChangesOptions,
  PushStage,
  RunSummary,
} from "./types.js";

/**
 * Uploads and updates the reviewed plan's changes, capped by `maxChanges`; never deletes. Uploaded
 * videos carry whether they have audio, and once the uploads are done the kept videos whose audio
 * Pane View does not know are probed and reported.
 */
export async function pushChanges(
  options: PushChangesOptions,
  observer?: LockstepObserver,
): Promise<RunSummary> {
  const { plan, signal } = options;
  throwIfAborted(signal);
  const uploadConcurrency = resolveUploadConcurrency(options.uploadConcurrency);
  const { items: itemsToPush } = plannedUploads(plan, options.maxChanges);
  const api = { apiToken: options.apiToken, apiUrl: options.apiUrl };
  const probe = onceUnavailable(options.probeAudio ?? probeHasAudio, observer);

  const summary: RunSummary =
    itemsToPush.length === 0
      ? { action: "push", applied: 0, failed: 0, skipped: 0, status: "completed" }
      : await pushUploads({ api, observer, options, probe, uploadConcurrency });

  if (summary.status !== "completed") {
    return summary;
  }

  // The run is already finalized as completed, so a cancel while probing ends the facts phase
  // and keeps that summary instead of turning the push into an error.
  try {
    const mediaFactsReported = await reportMissingAudioFacts({ api, observer, options, probe });

    if (mediaFactsReported > 0) {
      summary.mediaFactsReported = mediaFactsReported;
    }
  } catch (error) {
    if (!signal?.aborted) {
      throw error;
    }
  }

  return summary;
}

/**
 * The probe, warning once and then answering "unavailable" without trying again when ffprobe is
 * missing, so neither the uploads nor the facts phase spawn a command that cannot start.
 */
function onceUnavailable(probe: AudioProbe, observer: LockstepObserver | undefined): AudioProbe {
  let unavailable: FfprobeUnavailableError | undefined;

  return async (filePath, signal) => {
    if (unavailable) {
      throw unavailable;
    }

    try {
      return await probe(filePath, signal);
    } catch (error) {
      if (error instanceof FfprobeUnavailableError && !unavailable) {
        unavailable = error;
        observer?.onEvent({ type: "warning", message: error.message });
      }

      throw error;
    }
  };
}

/** A video's audio for its registration; undefined, with a warning, when it cannot be probed. */
async function uploadAudio({
  filePath,
  item,
  observer,
  probe,
  signal,
}: {
  filePath: string;
  item: MediaItem;
  observer: LockstepObserver | undefined;
  probe: AudioProbe;
  signal?: AbortSignal;
}): Promise<boolean | undefined> {
  if (item.mediaType !== "video") {
    return undefined;
  }

  try {
    return await probe(filePath, signal);
  } catch (error) {
    throwIfAborted(signal);

    if (!(error instanceof FfprobeUnavailableError)) {
      observer?.onEvent({
        type: "warning",
        message: `could not probe ${item.path} for audio: ${formatError(toError(error))}`,
      });
    }

    return undefined;
  }
}

/**
 * Probes the kept videos Pane View has no audio fact for and reports what it learns; returns how
 * many media objects Pane View updated. A failed report is a warning, not a failed push: the uploads are
 * already done, and the next push tries again.
 */
async function reportMissingAudioFacts({
  api,
  observer,
  options,
  probe,
}: {
  api: PaneViewApi;
  observer: LockstepObserver | undefined;
  options: PushChangesOptions;
  probe: AudioProbe;
}): Promise<number> {
  const { plan, signal } = options;
  const missing = videosMissingAudioFacts(plan);

  if (missing.length === 0) {
    return 0;
  }

  observer?.onEvent({
    type: "status",
    message: `Checking ${missing.length} synced video(s) for audio.`,
  });

  const facts = await probeAudioFacts({
    missing,
    onWarning: (message) => observer?.onEvent({ type: "warning", message }),
    probe,
    resolvePath: (archivePath) => resolveLocalFilePath(plan.sourceRoot, archivePath),
    signal,
  });

  let reported = 0;

  for (const body of mediaFactsRequests(facts)) {
    try {
      reported += await reportMediaFacts({ api, body, signal });
    } catch (error) {
      throwIfAborted(signal);
      observer?.onEvent({
        type: "warning",
        message: `videos' audio could not be reported: ${formatError(toError(error))}`,
      });

      break;
    }
  }

  return reported;
}

async function pushUploads({
  api,
  observer,
  options,
  probe,
  uploadConcurrency,
}: {
  api: PaneViewApi;
  observer: LockstepObserver | undefined;
  options: PushChangesOptions;
  probe: AudioProbe;
  uploadConcurrency: number;
}): Promise<RunSummary> {
  const { plan, signal } = options;
  const changedItems = plannedChanges(plan);
  const { items: itemsToPush, omittedCount } = plannedUploads(plan, options.maxChanges);

  observer?.onEvent({
    type: "status",
    message:
      omittedCount > 0
        ? `Pushing ${itemsToPush.length} of ${changedItems.length} changes (capped by max-changes).`
        : `Pushing ${itemsToPush.length} upload/update change(s).`,
  });

  const { cache: hashCache, warning: cacheWarning } = await loadHashCache({
    cacheRoot: options.hashCacheRoot,
    sourceRoot: plan.sourceRoot,
  });

  if (cacheWarning) {
    observer?.onEvent({ type: "warning", message: cacheWarning });
  }

  const run = await SyncRun.open({
    action: "push",
    api,
    observer,
    plan,
    signal,
  });

  const outcome = await run.apply(itemsToPush, uploadConcurrency, async (item, report) => {
    if (!item.local) {
      throw new Error(`The plan has no local file for ${item.path}.`);
    }

    const local = await hashPushItem({
      cache: hashCache,
      item: item.local,
      report,
      signal,
      sourceRoot: plan.sourceRoot,
    });

    const hasAudio = await uploadAudio({
      filePath: resolveLocalFilePath(plan.sourceRoot, local.path),
      item: local,
      observer,
      probe,
      signal,
    });

    await pushMediaItem({
      api,
      hasAudio,
      item: local,
      // Keep the existing library row when only case / jpeg↔jpg spelling differs.
      logicalPath: item.action === "update" && item.remote ? item.remote.path : local.path,
      onStage: report,
      signal,
      sourceRoot: plan.sourceRoot,
      syncRunId: run.syncRunId,
    });

    return { kind: "applied" };
  });

  await hashCache.save().catch((error) => {
    observer?.onEvent({
      type: "warning",
      message: `hash cache could not be saved: ${formatError(toError(error))}`,
    });
  });

  return run.finish(outcome);
}

/**
 * The item with its content hash, from the cache when the file is unchanged since planning. A file
 * that changed after planning, or while it is hashed, fails the item.
 */
async function hashPushItem({
  cache,
  item,
  report,
  signal,
  sourceRoot,
}: {
  cache: HashCache;
  item: MediaItem;
  report: (stage: PushStage, bytes?: { done: number; total: number }) => void;
  signal?: AbortSignal;
  sourceRoot: string;
}): Promise<HashedMediaItem> {
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
    report("hashing");
    sha256 = await hashLocalFile(
      filePath,
      fingerprint,
      (done) => report("hashing", { done, total: fingerprint.size }),
      signal,
    );
    cache.set(item.path, fingerprint, sha256);
  }

  return { ...item, id: sha256, sha256 };
}
