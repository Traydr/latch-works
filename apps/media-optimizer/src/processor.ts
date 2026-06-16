import { randomUUID } from "node:crypto";
import { snapThumbnailSize } from "@latch-works/media-delivery";
import { generateDerivativeBytes, readWebpMetadata } from "@latch-works/media-derivatives";
import {
  createS3StorageClient,
  headStoredObject,
  putStoredObject,
  readStoredObjectBytes,
  type S3StorageClient,
} from "@latch-works/media-storage";
import { env } from "./env.js";
import { logOptimizerError, logOptimizerEvent, sanitizeError } from "./logging.js";
import {
  claimJobs,
  type DerivativeJob,
  releaseJobs,
  reportComplete,
  reportFailure,
} from "./pane-view-client.js";

export interface ProcessResult {
  claimed: number;
  durationMs: number;
  emptyClaims: number;
  failed: number;
  processed: number;
  released: number;
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
  runId: string,
  storage: S3StorageClient,
): Promise<boolean> {
  const startedAt = Date.now();
  logOptimizerEvent("optimizer.job_start", {
    attemptCount: job.attemptCount,
    mediaObjectId: job.mediaObjectId,
    mediaType: job.mediaType,
    processingToken,
    runId,
    size: job.size,
  });

  try {
    const existingObject = await headStoredObject({ key: job.objectKey, storage });
    if (existingObject) {
      const bytes = await readStoredObjectBytes({ key: job.objectKey, storage });
      if (bytes) {
        const metadata = await readWebpMetadata(bytes);
        const completed = await reportComplete({
          height: metadata.height,
          mediaObjectId: job.mediaObjectId,
          objectKey: job.objectKey,
          processingToken,
          size: job.size,
          width: metadata.width,
        });

        if (!completed) {
          logOptimizerError("optimizer.job_stale_lease", {
            durationMs: Date.now() - startedAt,
            mediaObjectId: job.mediaObjectId,
            processingToken,
            runId,
            size: job.size,
          });
          return false;
        }

        logOptimizerEvent("optimizer.job_complete", {
          durationMs: Date.now() - startedAt,
          mediaObjectId: job.mediaObjectId,
          mediaType: job.mediaType,
          processingToken,
          runId,
          size: job.size,
          source: "existing_object",
        });
        return completed;
      }
    }

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

    const completed = await reportComplete({
      height: generated.height,
      mediaObjectId: job.mediaObjectId,
      objectKey: job.objectKey,
      processingToken,
      size: job.size,
      width: generated.width,
    });

    if (!completed) {
      logOptimizerError("optimizer.job_stale_lease", {
        durationMs: Date.now() - startedAt,
        mediaObjectId: job.mediaObjectId,
        processingToken,
        runId,
        size: job.size,
      });
      return false;
    }

    logOptimizerEvent("optimizer.job_complete", {
      durationMs: Date.now() - startedAt,
      mediaObjectId: job.mediaObjectId,
      mediaType: job.mediaType,
      processingToken,
      runId,
      size: job.size,
      source: "generated",
    });
    return completed;
  } catch (error) {
    const message = sanitizeError(error);
    try {
      await reportFailure({
        error: message,
        mediaObjectId: job.mediaObjectId,
        processingToken,
        size: job.size,
      });
    } catch (reportError) {
      logOptimizerError("optimizer.job_failure_report_failed", {
        error: sanitizeError(reportError),
        mediaObjectId: job.mediaObjectId,
        processingToken,
        runId,
        size: job.size,
      });
    }

    logOptimizerError("optimizer.job_failed", {
      durationMs: Date.now() - startedAt,
      error: message,
      mediaObjectId: job.mediaObjectId,
      mediaType: job.mediaType,
      processingToken,
      runId,
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
export async function processBatch(runId: string = randomUUID()): Promise<ProcessResult> {
  const startedAt = Date.now();
  const storage = getStorage();
  let claimed = 0;
  let emptyClaims = 0;
  let processed = 0;
  let released = 0;
  let succeeded = 0;
  let failed = 0;

  while (
    processed < env.OPTIMIZER_BATCH_LIMIT &&
    Date.now() - startedAt < env.OPTIMIZER_MAX_RUNTIME_MS
  ) {
    const remaining = env.OPTIMIZER_BATCH_LIMIT - processed;
    const limit = Math.min(remaining, env.OPTIMIZER_CLAIM_CHUNK);
    logOptimizerEvent("optimizer.claim_start", { limit, runId });
    const { jobs, processingToken } = await claimJobs(limit);
    claimed += jobs.length;
    logOptimizerEvent("optimizer.claim_complete", {
      jobCount: jobs.length,
      processingToken,
      runId,
    });

    if (jobs.length === 0) {
      emptyClaims += 1;
      break;
    }

    for (let index = 0; index < jobs.length; index += 1) {
      if (Date.now() - startedAt >= env.OPTIMIZER_MAX_RUNTIME_MS) {
        const remainingJobs = jobs.slice(index).map((job) => ({
          mediaObjectId: job.mediaObjectId,
          size: job.size,
        }));
        await releaseJobs({
          jobs: remainingJobs,
          processingToken,
        });
        released += remainingJobs.length;
        logOptimizerEvent("optimizer.jobs_released", {
          jobCount: remainingJobs.length,
          processingToken,
          runId,
        });
        break;
      }

      const job = jobs[index];
      if (!job) {
        continue;
      }

      const ok = await processJob(job, processingToken, runId, storage);
      processed += 1;
      if (ok) {
        succeeded += 1;
      } else {
        failed += 1;
      }
    }
  }

  const result = {
    claimed,
    durationMs: Date.now() - startedAt,
    emptyClaims,
    failed,
    processed,
    released,
    succeeded,
  };
  logOptimizerEvent("optimizer.batch_complete", { runId, ...result });
  return result;
}
