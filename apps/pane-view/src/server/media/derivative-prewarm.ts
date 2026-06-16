import { GALLERY_THUMBNAIL_SIZE, PREVIEW_DERIVATIVE_SIZE } from "@latch-works/media-delivery";
import {
  buildDerivativeDescriptor,
  supportsDerivative,
} from "@latch-works/media-derivatives/descriptor";
import { and, eq, inArray } from "drizzle-orm";
import { resolveDerivativeProcessingMode } from "../../env/server";
import { db } from "../db";
import { libraryEntries, mediaObjects, syncRunItems } from "../db/schema";
import { enqueueDerivativeJob } from "./derivative-queue";
import { logDerivativeEvent } from "./derivative-telemetry";
import { wakeOptimizer } from "./optimizer-wake";

const PREWARM_SCAN_LIMIT = 2_000;

/**
 * Primary good-UX trigger: after a sync run completes, enqueue gallery-size
 * derivatives for newly uploaded/updated image/GIF/video objects and wake the
 * optimizer so they are `ready` before the first gallery view. No-op in inline
 * mode (Pane View generates on demand there). Best-effort and non-fatal.
 */
export async function prewarmSyncRunDerivatives({
  syncRunId,
}: {
  syncRunId: string;
}): Promise<void> {
  if (resolveDerivativeProcessingMode() !== "triggered") {
    return;
  }

  const rows = await db
    .select({
      extension: mediaObjects.extension,
      contentChangedAt: libraryEntries.contentChangedAt,
      changedAt: libraryEntries.changedAt,
      firstSeenAt: libraryEntries.firstSeenAt,
      mediaCreatedAt: mediaObjects.createdAt,
      mediaObjectId: mediaObjects.id,
      mediaType: mediaObjects.mediaType,
      sha256: mediaObjects.sha256,
    })
    .from(syncRunItems)
    .innerJoin(mediaObjects, eq(syncRunItems.mediaObjectId, mediaObjects.id))
    .leftJoin(libraryEntries, eq(syncRunItems.logicalPath, libraryEntries.logicalPath))
    .where(
      and(
        eq(syncRunItems.syncRunId, syncRunId),
        inArray(syncRunItems.action, ["upload", "update"]),
      ),
    )
    .limit(PREWARM_SCAN_LIMIT + 1);

  const truncated = rows.length > PREWARM_SCAN_LIMIT;
  const cappedRows = truncated ? rows.slice(0, PREWARM_SCAN_LIMIT) : rows;

  const jobs = cappedRows.flatMap((row) => {
    if (!supportsDerivative(row.mediaType)) {
      return [];
    }

    const source = {
      extension: row.extension,
      mediaType: row.mediaType,
      sha256: row.sha256,
    };
    const priorityAt =
      row.contentChangedAt ?? row.changedAt ?? row.firstSeenAt ?? row.mediaCreatedAt ?? new Date();

    return [
      {
        intent: {
          priorityAt,
          source: "prewarm" as const,
          variant: "thumbnail" as const,
        },
        mediaObjectId: row.mediaObjectId,
        objectKey: buildDerivativeDescriptor(source, GALLERY_THUMBNAIL_SIZE).objectKey,
        size: GALLERY_THUMBNAIL_SIZE,
      },
      {
        intent: {
          priorityAt,
          source: "prewarm" as const,
          variant: "preview" as const,
        },
        mediaObjectId: row.mediaObjectId,
        objectKey: buildDerivativeDescriptor(source, PREVIEW_DERIVATIVE_SIZE).objectKey,
        size: PREVIEW_DERIVATIVE_SIZE,
      },
    ];
  });

  if (jobs.length === 0) {
    return;
  }

  const enqueueResults = await Promise.all(jobs.map((job) => enqueueDerivativeJob(job)));
  const enqueued = enqueueResults.filter(Boolean).length;

  logDerivativeEvent("derivative.prewarm", {
    eligible: jobs.length,
    enqueued,
    scanned: cappedRows.length,
    skippedExisting: jobs.length - enqueued,
    syncRunId,
    truncated,
  });

  if (enqueued > 0) {
    await wakeOptimizer("prewarm");
  }
}
