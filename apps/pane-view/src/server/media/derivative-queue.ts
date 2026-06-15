import type { ThumbnailSize } from "@latch-works/media-delivery";
import type { MediaType } from "@latch-works/media-domain";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "../db";
import { mediaObjects, thumbnails } from "../db/schema";
import { derivativeProcessingLeaseMs } from "./derivative-lease";

export const DERIVATIVE_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 60 * 60_000;

export interface DerivativeJob {
  attemptCount: number;
  extension: string;
  mediaObjectId: string;
  mediaType: MediaType;
  objectKey: string;
  originalObjectKey: string;
  sha256: string;
  size: number;
}

/**
 * Atomically leases up to `limit` schedulable pending derivative rows to the
 * caller, stamping each with `processingToken`. Uses `FOR UPDATE SKIP LOCKED`
 * so concurrent claimers never contend, and joins `media_objects` so the worker
 * has everything it needs to read the source and write the derivative.
 */
export async function claimDerivativeJobs({
  limit,
  processingToken,
}: {
  limit: number;
  processingToken: string;
}): Promise<DerivativeJob[]> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const leaseExpiry = new Date(now.getTime() - derivativeProcessingLeaseMs);
    const eligible = await tx
      .select({ mediaObjectId: thumbnails.mediaObjectId, size: thumbnails.size })
      .from(thumbnails)
      .where(
        or(
          and(
            eq(thumbnails.status, "pending"),
            or(isNull(thumbnails.nextAttemptAt), lte(thumbnails.nextAttemptAt, now)),
          ),
          // Reclaim crashed/timed-out runs whose processing lease has expired.
          and(eq(thumbnails.status, "processing"), lte(thumbnails.updatedAt, leaseExpiry)),
        ),
      )
      .orderBy(asc(thumbnails.nextAttemptAt), asc(thumbnails.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (eligible.length === 0) {
      return [];
    }

    for (const row of eligible) {
      await tx
        .update(thumbnails)
        .set({ processingToken, status: "processing", updatedAt: now })
        .where(and(eq(thumbnails.mediaObjectId, row.mediaObjectId), eq(thumbnails.size, row.size)));
    }

    return tx
      .select({
        attemptCount: thumbnails.attemptCount,
        extension: mediaObjects.extension,
        mediaObjectId: thumbnails.mediaObjectId,
        mediaType: mediaObjects.mediaType,
        objectKey: thumbnails.objectKey,
        originalObjectKey: mediaObjects.objectKey,
        sha256: mediaObjects.sha256,
        size: thumbnails.size,
      })
      .from(thumbnails)
      .innerJoin(mediaObjects, eq(thumbnails.mediaObjectId, mediaObjects.id))
      .where(
        and(eq(thumbnails.processingToken, processingToken), eq(thumbnails.status, "processing")),
      );
  });
}

/**
 * Marks a leased derivative row `ready`. The compare-and-set on
 * `processingToken` ensures a crashed/reclaimed run cannot overwrite a row that
 * another worker now owns. Returns false when the lease no longer matches.
 */
export async function completeDerivativeJob({
  height,
  mediaObjectId,
  objectKey,
  processingToken,
  size,
  width,
}: {
  height: number;
  mediaObjectId: string;
  objectKey: string;
  processingToken: string;
  size: number;
  width: number;
}): Promise<boolean> {
  const updated = await db
    .update(thumbnails)
    .set({
      error: null,
      height,
      nextAttemptAt: null,
      objectKey,
      processingToken: null,
      status: "ready",
      updatedAt: new Date(),
      width,
    })
    .where(
      and(
        eq(thumbnails.mediaObjectId, mediaObjectId),
        eq(thumbnails.size, size),
        eq(thumbnails.processingToken, processingToken),
      ),
    )
    .returning({ mediaObjectId: thumbnails.mediaObjectId });

  return updated.length > 0;
}

/**
 * Returns a leased `processing` row to `pending` without incrementing attempts.
 * Used when an optimizer batch exits before it can process every claimed job.
 */
export async function releaseDerivativeJob({
  mediaObjectId,
  processingToken,
  size,
}: {
  mediaObjectId: string;
  processingToken: string;
  size: number;
}): Promise<boolean> {
  const updated = await db
    .update(thumbnails)
    .set({
      processingToken: null,
      status: "pending",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(thumbnails.mediaObjectId, mediaObjectId),
        eq(thumbnails.size, size),
        eq(thumbnails.processingToken, processingToken),
        eq(thumbnails.status, "processing"),
      ),
    )
    .returning({ mediaObjectId: thumbnails.mediaObjectId });

  return updated.length > 0;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attemptCount);
}

export interface FailDerivativeResult {
  matched: boolean;
  status?: "failed" | "pending";
}

/**
 * Records a generation failure for a leased row. Increments the attempt count
 * and either reschedules with backoff (`pending`) or gives up (`failed`) once
 * the attempt budget is exhausted.
 */
export async function failDerivativeJob({
  error,
  maxAttempts = DERIVATIVE_MAX_ATTEMPTS,
  mediaObjectId,
  processingToken,
  size,
}: {
  error: string;
  maxAttempts?: number;
  mediaObjectId: string;
  processingToken: string;
  size: number;
}): Promise<FailDerivativeResult> {
  const [existing] = await db
    .select({ attemptCount: thumbnails.attemptCount })
    .from(thumbnails)
    .where(
      and(
        eq(thumbnails.mediaObjectId, mediaObjectId),
        eq(thumbnails.size, size),
        eq(thumbnails.processingToken, processingToken),
      ),
    )
    .limit(1);

  if (!existing) {
    return { matched: false };
  }

  const nextAttempt = existing.attemptCount + 1;
  const giveUp = nextAttempt >= maxAttempts;
  const status = giveUp ? "failed" : "pending";

  const updated = await db
    .update(thumbnails)
    .set({
      attemptCount: nextAttempt,
      error,
      nextAttemptAt: giveUp ? null : new Date(Date.now() + retryDelayMs(nextAttempt)),
      processingToken: null,
      status,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(thumbnails.mediaObjectId, mediaObjectId),
        eq(thumbnails.size, size),
        eq(thumbnails.processingToken, processingToken),
      ),
    )
    .returning({ mediaObjectId: thumbnails.mediaObjectId });

  if (updated.length === 0) {
    return { matched: false };
  }

  return { matched: true, status };
}

/**
 * Inserts a `pending` derivative row for a media object at a given size if one
 * does not already exist. Idempotent: existing rows (any status) are left
 * untouched so ready/processing work is not disturbed. Returns true when a new
 * row was enqueued.
 */
export async function enqueueDerivativeJob({
  mediaObjectId,
  objectKey,
  size,
}: {
  mediaObjectId: string;
  objectKey: string;
  size: ThumbnailSize;
}): Promise<boolean> {
  const inserted = await db
    .insert(thumbnails)
    .values({
      height: 0,
      mediaObjectId,
      objectKey,
      nextAttemptAt: null,
      size,
      status: "pending",
      width: 0,
    })
    .onConflictDoNothing({ target: [thumbnails.mediaObjectId, thumbnails.size] })
    .returning({ mediaObjectId: thumbnails.mediaObjectId });

  return inserted.length > 0;
}
