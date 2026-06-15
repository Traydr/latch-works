import { snapThumbnailSize } from "@latch-works/media-delivery";
import { generateDerivativeBytes } from "@latch-works/media-derivatives";
import {
  createS3StorageClient,
  putStoredObject,
  type S3StorageClient,
} from "@latch-works/media-storage";
import { env } from "./env.js";
import {
  claimJobs,
  type DerivativeJob,
  reportComplete,
  reportFailure,
} from "./pane-view-client.js";

export interface ProcessResult {
  durationMs: number;
  failed: number;
  processed: number;
  succeeded: number;
}

let storageClient: S3StorageClient | null = null;

function getStorage(): S3StorageClient {
  if (!storageClient) {
    storageClient = createS3StorageClient({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
  }

  return storageClient;
}

async function processJob(
  job: DerivativeJob,
  processingToken: string,
  storage: S3StorageClient,
): Promise<boolean> {
  try {
    const generated = await generateDerivativeBytes({
      size: snapThumbnailSize(job.size),
      source: {
        extension: job.extension,
        mediaType: job.mediaType,
        originalObjectKey: job.originalObjectKey,
        sha256: job.sha256,
      },
      storage,
    });

    await putStoredObject({
      body: generated.bytes,
      contentType: "image/webp",
      key: job.objectKey,
      storage,
    });

    await reportComplete({
      height: generated.height,
      mediaObjectId: job.mediaObjectId,
      objectKey: job.objectKey,
      processingToken,
      size: job.size,
      width: generated.width,
    });

    return true;
  } catch (error) {
    await reportFailure({
      error: error instanceof Error ? error.message : "derivative generation failed",
      mediaObjectId: job.mediaObjectId,
      processingToken,
      size: job.size,
    });

    return false;
  }
}

/**
 * Drains the Pane View derivative queue, processing jobs strictly sequentially
 * (concurrency 1) until the batch limit or runtime budget is reached, or the
 * queue is empty.
 */
export async function processBatch(): Promise<ProcessResult> {
  const startedAt = Date.now();
  const storage = getStorage();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  while (
    processed < env.OPTIMIZER_BATCH_LIMIT &&
    Date.now() - startedAt < env.OPTIMIZER_MAX_RUNTIME_MS
  ) {
    const remaining = env.OPTIMIZER_BATCH_LIMIT - processed;
    const limit = Math.min(remaining, env.OPTIMIZER_CLAIM_CHUNK);
    const { jobs, processingToken } = await claimJobs(limit);

    if (jobs.length === 0) {
      break;
    }

    for (const job of jobs) {
      if (Date.now() - startedAt >= env.OPTIMIZER_MAX_RUNTIME_MS) {
        // Remaining claimed jobs stay 'processing' and are reclaimed by a later
        // run once their lease expires.
        break;
      }

      const ok = await processJob(job, processingToken, storage);
      processed += 1;
      if (ok) {
        succeeded += 1;
      } else {
        failed += 1;
      }
    }
  }

  return { durationMs: Date.now() - startedAt, failed, processed, succeeded };
}
