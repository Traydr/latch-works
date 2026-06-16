import { GALLERY_THUMBNAIL_SIZE, PREVIEW_DERIVATIVE_SIZE } from "@latch-works/media-delivery";
import {
  buildDerivativeDescriptor,
  supportsDerivative,
} from "@latch-works/media-derivatives/descriptor";
import { and, eq, inArray } from "drizzle-orm";
import { resolveDerivativeProcessingMode } from "../../env/server";
import { db } from "../db";
import { mediaObjects, syncRunItems, thumbnails } from "../db/schema";
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
      mediaObjectId: mediaObjects.id,
      mediaType: mediaObjects.mediaType,
      sha256: mediaObjects.sha256,
    })
    .from(syncRunItems)
    .innerJoin(mediaObjects, eq(syncRunItems.mediaObjectId, mediaObjects.id))
    .where(
      and(
        eq(syncRunItems.syncRunId, syncRunId),
        inArray(syncRunItems.action, ["upload", "update"]),
      ),
    )
    .limit(PREWARM_SCAN_LIMIT + 1);

  const truncated = rows.length > PREWARM_SCAN_LIMIT;
  const cappedRows = truncated ? rows.slice(0, PREWARM_SCAN_LIMIT) : rows;

  const values = cappedRows.flatMap((row) => {
    if (!supportsDerivative(row.mediaType)) {
      return [];
    }

    const source = {
      extension: row.extension,
      mediaType: row.mediaType,
      sha256: row.sha256,
    };

    return [
      {
        height: 0,
        mediaObjectId: row.mediaObjectId,
        nextAttemptAt: null,
        objectKey: buildDerivativeDescriptor(source, GALLERY_THUMBNAIL_SIZE).objectKey,
        size: GALLERY_THUMBNAIL_SIZE,
        status: "pending" as const,
        width: 0,
      },
      {
        height: 0,
        mediaObjectId: row.mediaObjectId,
        nextAttemptAt: null,
        objectKey: buildDerivativeDescriptor(source, PREVIEW_DERIVATIVE_SIZE).objectKey,
        size: PREVIEW_DERIVATIVE_SIZE,
        status: "pending" as const,
        width: 0,
      },
    ];
  });

  if (values.length === 0) {
    return;
  }

  const inserted = await db
    .insert(thumbnails)
    .values(values)
    .onConflictDoNothing({ target: [thumbnails.mediaObjectId, thumbnails.size] })
    .returning({ mediaObjectId: thumbnails.mediaObjectId });

  logDerivativeEvent("derivative.prewarm", {
    enqueued: inserted.length,
    scanned: cappedRows.length,
    syncRunId,
    truncated,
  });

  if (inserted.length > 0) {
    await wakeOptimizer("prewarm");
  }
}
