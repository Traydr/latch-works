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
      const target = event.scope === "global" ? "any supported page" : `a ${label} page`;
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
          message:
            `Complete. Saved ${event.saved}, skipped ${event.skipped}, ` +
            `failed ${event.failed}.`
        }
      };
    default:
      throw new Error(`Rejected unknown Gather Run event kind: ${kind}`);
  }
}
