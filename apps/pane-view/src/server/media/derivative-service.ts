import { snapThumbnailSize } from "@latch-works/media-delivery";
import type { FfmpegRunner } from "@latch-works/media-derivatives";
import {
  buildDerivativeDescriptor,
  supportsDerivative,
} from "@latch-works/media-derivatives/descriptor";
import {
  deleteStoredObject,
  headStoredObject,
  putStoredObject,
  readStoredObjectBytes,
} from "@latch-works/media-storage";
import { and, eq } from "drizzle-orm";
import { resolveDerivativeProcessingMode } from "../../env/server";
import { db } from "../db";
import { thumbnails } from "../db/schema";
import { createConcurrencyLimiter } from "./concurrency-limiter";
import { isDerivativeProcessingLeaseExpired } from "./derivative-lease";
import { logDerivativeEvent } from "./derivative-telemetry";
import { wakeOptimizer } from "./optimizer-wake";
import { readMediaThumbnailContext } from "./repository";
import { createPaneViewStorageClient } from "./storage-client";

const derivativeGenerationLimiter = createConcurrencyLimiter(2);

// CPU-heavy generation lives in `@latch-works/media-derivatives` and is loaded
// via dynamic import so that `sharp`/`ffmpeg-static` are only pulled into the
// Pane View process when it actually generates (inline mode). The pure
// descriptor helpers come from the sharp-free `/descriptor` subpath.
let ffmpegRunnerOverride: FfmpegRunner | null = null;
let maxSourceBytesOverride: number | null = null;

export const derivativeServiceTestHooks = {
  resetFfmpegRunner(): void {
    ffmpegRunnerOverride = null;
  },
  resetMaxSourceBytes(): void {
    maxSourceBytesOverride = null;
  },
  setFfmpegRunner(runner: FfmpegRunner): void {
    ffmpegRunnerOverride = runner;
  },
  setMaxSourceBytes(bytes: number): void {
    maxSourceBytesOverride = bytes;
  },
};

export type ThumbnailEnsureResult =
  | {
      status: "ready";
      objectKey: string;
      purpose: "thumbnail" | "preview";
      width: number;
      height: number;
    }
  | { status: "pending" }
  | { status: "failed" }
  | { status: "unsupported" };

export async function invalidateThumbnailDerivatives({
  mediaId,
}: {
  mediaId: string;
}): Promise<{ status: "not_found" } | { status: "ok" } | { status: "unsupported" }> {
  const context = await readMediaThumbnailContext({ mediaId });
  if (!context) {
    return { status: "not_found" };
  }

  if (!supportsDerivative(context.mediaType)) {
    return { status: "unsupported" };
  }

  const storage = createPaneViewStorageClient();
  const rows = await db
    .select({ objectKey: thumbnails.objectKey })
    .from(thumbnails)
    .where(eq(thumbnails.mediaObjectId, context.mediaObjectId));

  await Promise.all(
    rows.map(async (row) => {
      try {
        await deleteStoredObject({ key: row.objectKey, storage });
      } catch {
        // Best effort: stale storage objects should not block regeneration.
      }
    }),
  );

  await db.delete(thumbnails).where(eq(thumbnails.mediaObjectId, context.mediaObjectId));

  return { status: "ok" };
}

const thumbnailPurgeBatchSize = 500;

export async function purgeAllThumbnailDerivatives(): Promise<{
  deletedRows: number;
  s3Errors: number;
}> {
  const storage = createPaneViewStorageClient();
  let deletedRows = 0;
  let s3Errors = 0;

  while (true) {
    const rows = await db
      .select({
        mediaObjectId: thumbnails.mediaObjectId,
        objectKey: thumbnails.objectKey,
        size: thumbnails.size,
      })
      .from(thumbnails)
      .limit(thumbnailPurgeBatchSize);

    if (rows.length === 0) {
      break;
    }

    await Promise.all(
      rows.map(async (row) => {
        try {
          await deleteStoredObject({ key: row.objectKey, storage });
        } catch {
          s3Errors += 1;
        }
      }),
    );

    for (const row of rows) {
      await db
        .delete(thumbnails)
        .where(and(eq(thumbnails.mediaObjectId, row.mediaObjectId), eq(thumbnails.size, row.size)));
      deletedRows += 1;
    }
  }

  return { deletedRows, s3Errors };
}

export async function regenerateThumbnailDerivative({
  mediaId,
  requestedSize,
}: {
  mediaId: string;
  requestedSize: number;
}): Promise<ThumbnailEnsureResult> {
  const invalidated = await invalidateThumbnailDerivatives({ mediaId });
  if (invalidated.status === "not_found") {
    return { status: "failed" };
  }

  if (invalidated.status === "unsupported") {
    return { status: "unsupported" };
  }

  return ensureThumbnailDerivative({ mediaId, requestedSize });
}

export async function ensurePreviewDerivative({
  mediaId,
}: {
  mediaId: string;
}): Promise<ThumbnailEnsureResult> {
  return ensureThumbnailDerivative({ mediaId, requestedSize: 960 });
}

export async function ensureThumbnailDerivative({
  mediaId,
  requestedSize,
}: {
  mediaId: string;
  requestedSize: number;
}): Promise<ThumbnailEnsureResult> {
  const size = snapThumbnailSize(requestedSize);
  const context = await readMediaThumbnailContext({ mediaId });
  if (!context) {
    return { status: "failed" };
  }

  if (!supportsDerivative(context.mediaType)) {
    return { status: "unsupported" };
  }

  const derivative = buildDerivativeDescriptor(context, size);
  const [existing] = await db
    .select()
    .from(thumbnails)
    .where(and(eq(thumbnails.mediaObjectId, context.mediaObjectId), eq(thumbnails.size, size)))
    .limit(1);

  if (existing?.status === "ready") {
    return {
      height: existing.height,
      objectKey: existing.objectKey,
      purpose: derivative.purpose,
      status: "ready",
      width: existing.width,
    };
  }

  if (existing?.status === "processing") {
    if (!isDerivativeProcessingLeaseExpired(existing.updatedAt)) {
      return { status: "pending" };
    }

    await db
      .update(thumbnails)
      .set({
        error: null,
        status: "pending",
        updatedAt: new Date(),
      })
      .where(and(eq(thumbnails.mediaObjectId, context.mediaObjectId), eq(thumbnails.size, size)));
  }

  if (!existing) {
    await db.insert(thumbnails).values({
      height: 0,
      mediaObjectId: context.mediaObjectId,
      objectKey: derivative.objectKey,
      size,
      status: "pending",
      width: 0,
    });
  } else if (existing.status === "failed") {
    await db
      .update(thumbnails)
      .set({
        error: null,
        objectKey: derivative.objectKey,
        status: "pending",
        updatedAt: new Date(),
      })
      .where(and(eq(thumbnails.mediaObjectId, context.mediaObjectId), eq(thumbnails.size, size)));
  }

  // In triggered mode Pane View never generates inline: the row is now pending
  // and the media-optimizer service claims and generates it out of band, so the
  // heavy sharp/ffmpeg path is never loaded into this process. Nudge the
  // optimizer (throttled, non-fatal) so on-demand requests don't wait for the
  // next prewarm/cron.
  if (resolveDerivativeProcessingMode() === "triggered") {
    void wakeOptimizer("on-demand");
    return { status: "pending" };
  }

  const [claimed] = await db
    .update(thumbnails)
    .set({ status: "processing", updatedAt: new Date() })
    .where(
      and(
        eq(thumbnails.mediaObjectId, context.mediaObjectId),
        eq(thumbnails.size, size),
        eq(thumbnails.status, "pending"),
      ),
    )
    .returning();

  if (!claimed) {
    return { status: "pending" };
  }

  try {
    const storage = createPaneViewStorageClient();
    const existingObject = await headStoredObject({ key: derivative.objectKey, storage });
    if (existingObject) {
      const metadata = await readWebpMetadataFromStorage(derivative.objectKey, storage);
      await markThumbnailReady({
        height: metadata.height,
        mediaObjectId: context.mediaObjectId,
        objectKey: derivative.objectKey,
        size,
        width: metadata.width,
      });
      return {
        height: metadata.height,
        objectKey: derivative.objectKey,
        purpose: derivative.purpose,
        status: "ready",
        width: metadata.width,
      };
    }

    const generationStartedAt = Date.now();
    const generated = await derivativeGenerationLimiter.run(async () => {
      const { generateDerivativeBytes } = await import("@latch-works/media-derivatives");
      return generateDerivativeBytes({
        ffmpegRunner: ffmpegRunnerOverride ?? undefined,
        maxSourceBytes: maxSourceBytesOverride ?? undefined,
        size,
        source: {
          extension: context.extension,
          mediaType: context.mediaType,
          originalObjectKey: context.originalObjectKey,
          sha256: context.sha256,
        },
        storage,
      });
    });
    logDerivativeEvent("derivative.generate", {
      durationMs: Date.now() - generationStartedAt,
      mediaType: context.mediaType,
      purpose: derivative.purpose,
      size,
    });
    await putStoredObject({
      body: generated.bytes,
      contentType: "image/webp",
      key: derivative.objectKey,
      storage,
    });
    await markThumbnailReady({
      height: generated.height,
      mediaObjectId: context.mediaObjectId,
      objectKey: derivative.objectKey,
      size,
      width: generated.width,
    });

    return {
      height: generated.height,
      objectKey: derivative.objectKey,
      purpose: derivative.purpose,
      status: "ready",
      width: generated.width,
    };
  } catch (error) {
    await db
      .update(thumbnails)
      .set({
        error: error instanceof Error ? error.message : "thumbnail generation failed",
        status: "failed",
        updatedAt: new Date(),
      })
      .where(and(eq(thumbnails.mediaObjectId, context.mediaObjectId), eq(thumbnails.size, size)));

    return { status: "failed" };
  }
}

async function readWebpMetadataFromStorage(
  objectKey: string,
  storage: ReturnType<typeof createPaneViewStorageClient>,
): Promise<{ height: number; width: number }> {
  const bytes = await readStoredObjectBytes({ key: objectKey, storage });
  if (!bytes) {
    throw new Error(`derivative object missing: ${objectKey}`);
  }

  const { readWebpMetadata } = await import("@latch-works/media-derivatives");
  return readWebpMetadata(bytes);
}

async function markThumbnailReady({
  height,
  mediaObjectId,
  objectKey,
  size,
  width,
}: {
  height: number;
  mediaObjectId: string;
  objectKey: string;
  size: number;
  width: number;
}): Promise<void> {
  await db
    .update(thumbnails)
    .set({
      error: null,
      height,
      objectKey,
      status: "ready",
      updatedAt: new Date(),
      width,
    })
    .where(and(eq(thumbnails.mediaObjectId, mediaObjectId), eq(thumbnails.size, size)));
}
