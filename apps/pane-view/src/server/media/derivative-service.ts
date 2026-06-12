import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { snapThumbnailSize, type ThumbnailSize } from "@latch-works/media-delivery";
import type { MediaType } from "@latch-works/media-domain";
import {
  deleteStoredObject,
  getStoredObject,
  headStoredObject,
  originalObjectKey,
  previewObjectKey,
  putStoredObject,
  readStoredObjectBytes,
  thumbnailObjectKey,
} from "@latch-works/media-storage";
import { and, eq } from "drizzle-orm";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { db } from "../db";
import { thumbnails } from "../db/schema";
import { createConcurrencyLimiter } from "./concurrency-limiter";
import { isDerivativeProcessingLeaseExpired } from "./derivative-lease";
import { readMediaThumbnailContext } from "./repository";
import { createPaneViewStorageClient } from "./storage-client";

const defaultMaxSourceBytes = 512 * 1024 * 1024;
const derivativeGenerationLimiter = createConcurrencyLimiter(2);

type FfmpegRunner = (binaryPath: string, args: string[]) => Promise<void>;

let ffmpegRunner: FfmpegRunner = runFfmpeg;
let maxSourceBytesOverride: number | null = null;

function getMaxSourceBytes(): number {
  return maxSourceBytesOverride ?? defaultMaxSourceBytes;
}

export const derivativeServiceTestHooks = {
  resetFfmpegRunner(): void {
    ffmpegRunner = runFfmpeg;
  },
  resetMaxSourceBytes(): void {
    maxSourceBytesOverride = null;
  },
  setFfmpegRunner(runner: FfmpegRunner): void {
    ffmpegRunner = runner;
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
        .where(
          and(eq(thumbnails.mediaObjectId, row.mediaObjectId), eq(thumbnails.size, row.size)),
        );
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

    const generated = await derivativeGenerationLimiter.run(() =>
      generateDerivativeBytes(context, size),
    );
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

function supportsDerivative(mediaType: MediaType): boolean {
  return mediaType === "image" || mediaType === "gif" || mediaType === "video";
}

function buildDerivativeDescriptor(
  context: Awaited<ReturnType<typeof readMediaThumbnailContext>>,
  size: ThumbnailSize,
): { objectKey: string; purpose: "thumbnail" | "preview" } {
  if (!context) {
    throw new Error("missing media thumbnail context");
  }

  if (context.mediaType === "video") {
    return {
      objectKey: previewObjectKey({
        extension: context.extension,
        mediaType: "video",
        sha256: context.sha256,
        size,
      }),
      purpose: "preview",
    };
  }

  return {
    objectKey: thumbnailObjectKey({
      extension: context.extension,
      mediaType: context.mediaType,
      sha256: context.sha256,
      size,
    }),
    purpose: "thumbnail",
  };
}

async function generateDerivativeBytes(
  context: NonNullable<Awaited<ReturnType<typeof readMediaThumbnailContext>>>,
  size: ThumbnailSize,
): Promise<{ bytes: Buffer; height: number; width: number }> {
  const storage = createPaneViewStorageClient();
  const sourceKey =
    context.originalObjectKey ??
    originalObjectKey({
      extension: context.extension,
      mediaType: context.mediaType,
      sha256: context.sha256,
    });

  if (context.mediaType === "video") {
    const posterFrame = await extractVideoPosterFrameFromStorage({
      extension: context.extension,
      sourceKey,
      storage,
    });
    return resizeImageToWebp(posterFrame, size);
  }

  const maxBytes = getMaxSourceBytes();
  const sourceHead = await headStoredObject({ key: sourceKey, storage });
  if (!sourceHead) {
    throw new Error(`original object missing: ${sourceKey}`);
  }

  if (sourceHead.contentLength > maxBytes) {
    throw new Error(`original object exceeds ${maxBytes} bytes`);
  }

  const sourceBytes = await readStoredObjectBytes({ key: sourceKey, storage });
  if (!sourceBytes) {
    throw new Error(`original object missing: ${sourceKey}`);
  }

  if (sourceBytes.byteLength > maxBytes) {
    throw new Error(`original object exceeds ${maxBytes} bytes`);
  }

  return resizeImageToWebp(sourceBytes, size);
}

async function extractVideoPosterFrameFromStorage({
  extension,
  sourceKey,
  storage,
}: {
  extension: string;
  sourceKey: string;
  storage: ReturnType<typeof createPaneViewStorageClient>;
}): Promise<Buffer> {
  const stored = await getStoredObject({ key: sourceKey, storage });
  if (!stored?.body) {
    throw new Error(`original object missing: ${sourceKey}`);
  }

  const maxBytes = getMaxSourceBytes();
  if (stored.contentLength !== undefined && stored.contentLength > maxBytes) {
    stored.body.destroy();
    throw new Error(`original object exceeds ${maxBytes} bytes`);
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "pane-view-thumb-"));
  const inputPath = path.join(tempDir, `source.${extension.replace(/^\./, "")}`);

  try {
    await streamReadableToTempFile({
      body: stored.body,
      destinationPath: inputPath,
      maxBytes,
    });
    return await extractVideoPosterFrameAtPath(inputPath, tempDir);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function streamReadableToTempFile({
  body,
  destinationPath,
  maxBytes,
}: {
  body: Readable;
  destinationPath: string;
  maxBytes: number;
}): Promise<void> {
  let bytesWritten = 0;

  const byteLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        callback(new Error(`original object exceeds ${maxBytes} bytes`));
        return;
      }

      callback(null, chunk);
    },
  });

  await pipeline(body, byteLimiter, createWriteStream(destinationPath));
}

async function resizeImageToWebp(
  input: Buffer,
  size: ThumbnailSize,
): Promise<{ bytes: Buffer; height: number; width: number }> {
  const result = await sharp(input)
    .rotate()
    .resize(size, size, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 90 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: result.data,
    height: result.info.height,
    width: result.info.width,
  };
}

async function extractVideoPosterFrameAtPath(inputPath: string, tempDir: string): Promise<Buffer> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg binary is not available");
  }

  const outputPath = path.join(tempDir, "poster.jpg");

  await ffmpegRunner(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    "1",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ]);

  return await readFile(outputPath);
}

function runFfmpeg(binaryPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${String(code)}`));
    });
  });
}

async function readWebpMetadataFromStorage(
  objectKey: string,
  storage: ReturnType<typeof createPaneViewStorageClient>,
): Promise<{ height: number; width: number }> {
  const bytes = await readStoredObjectBytes({ key: objectKey, storage });
  if (!bytes) {
    throw new Error(`derivative object missing: ${objectKey}`);
  }

  const metadata = await sharp(bytes).metadata();
  return {
    height: metadata.height ?? 0,
    width: metadata.width ?? 0,
  };
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
