import type { GatherRunEvent } from "./gather-run-messages";
import type { GatherRunState } from "./gather-run";
import { getGatherSource } from "./source-catalog";

export function applyGatherRunEvent(
  run: GatherRunState,
  event: GatherRunEvent,
  now = Date.now()
): GatherRunState {
  // Read before the switch: inside `default` the event has already narrowed to `never`.
  const { kind } = event;

  switch (event.kind) {
    case "permission-required": {
      // A paused job blocks the whole queue, and only a gather started from a tab that resolves to
      // the same folder handle can confirm it. Name that tab instead of asking for "confirmation".
      const label = getGatherSource(run.siteKey)?.label ?? "this source";
      const page = event.scope === "global" ? "any supported page" : `a ${label} page`;
      const target = event.profileName ? `${page} with the "${event.profileName}" profile` : page;

      return {
        ...run,
        updatedAt: now,
        phase: "permission-required",
        error: null,
        progress: {
          ...run.progress,
          message: `Folder access for ${label} needs confirmation from ${target}.`
        },
        log: [
          ...run.log,
          {
            message: `Queue paused. Start a gather on ${target} to confirm folder access.`,
            tone: "error"
          }
        ]
      };
    }

    case "writing":
      return {
        ...run,
        updatedAt: now,
        phase: "writing",
        destinationPreview: event.destinationPreview,
        folderSegments: event.folderSegments,
        progress: { ...run.progress, total: event.total, message: "Writing Gather Output..." }
      };
    case "progress":
      return {
        ...run,
        updatedAt: now,
        progress: {
          ...run.progress,
          completed: event.completed,
          total: event.total,
          message: event.message
        }
      };
    case "log":
      return { ...run, updatedAt: now, log: [...run.log, event] };
    case "failed":
      return {
        ...run,
        updatedAt: now,
        phase: "failed",
        error: event.message,
        progress: { ...run.progress, message: "Gather Run failed." },
        log: [...run.log, { message: event.message, tone: "error" }]
      };
    case "cancelled":
      return {
        ...run,
        updatedAt: now,
        phase: "cancelled",
        error: event.message ?? "Gather Run cancelled.",
        progress: { ...run.progress, message: "Gather Run cancelled." },
        log: [...run.log, { message: event.message ?? "Gather Run cancelled.", tone: "error" }]
      };
    case "complete":
      return {
        ...run,
        updatedAt: now,
        phase: event.failed > 0 ? "failed" : "complete",
        error: event.failed > 0 ? `${event.failed} item(s) failed.` : null,
        failedItems: event.failedItems,
        retryImages: event.retryImages,
        progress: {
          ...run.progress,
          completed: run.progress.total,
          saved: event.saved,
          skipped: event.skipped,
          failed: event.failed,
          message: describeCompletedRun(event)
        }
      };
    default:
      throw new Error(`Rejected unknown Gather Run event kind: ${kind}`);
  }
}

/** A file a site check blocked, which you downloaded yourself and Gather Box then saved. */
export interface HandedBackFile {
  runId: string;
  /** The failed item's file name, which identifies it in the run. */
  fileName: string;
  /** The name it was saved under, which differs when the planned name was already taken. */
  savedFileName: string;
}

/**
 * Moves a handed-back item from failed to saved. `updatedAt` is left alone: it places the run in
 * its batch and among the results, and handing a file back later does not move the run there.
 */
export function applyHandedBackFile(run: GatherRunState, file: HandedBackFile): GatherRunState {
  const failedItems = run.failedItems.filter(
    (item) => item.kind !== "site-check" || item.fileName !== file.fileName
  );

  const counts = {
    saved: run.progress.saved + 1,
    skipped: run.progress.skipped,
    failed: Math.max(0, run.progress.failed - 1)
  };

  return {
    ...run,
    phase: counts.failed > 0 ? "failed" : "complete",
    error: counts.failed > 0 ? `${counts.failed} item(s) failed.` : null,
    failedItems,
    retryImages: run.retryImages.filter((image) => image.fileName !== file.fileName),
    progress: { ...run.progress, ...counts, message: describeCompletedRun(counts) },
    log: [
      ...run.log,
      { message: `Saved ${file.savedFileName} from the file you added.`, tone: "success" }
    ]
  };
}

function describeCompletedRun(counts: { saved: number; skipped: number; failed: number }): string {
  return `Complete. Saved ${counts.saved}, skipped ${counts.skipped}, failed ${counts.failed}.`;
}
