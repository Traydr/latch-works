import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline, Readable, Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { getBaseName, getExtension, type MediaItem } from "@latch-works/media-domain";
import {
  ArchiveMediaTypeSchema,
  type CompleteObjectRequest,
  type CompleteSyncRunRequest,
  type CreateSyncRunRequest,
  completeSyncRunRoute,
  contentTypeForExtension,
  type DeleteObjectRequest,
  SYNC_ROUTES,
  SyncRunSchema,
  UploadTargetSchema,
  type UploadUrlRequest,
} from "@latch-works/sync-protocol";
import { z } from "zod";
import { toError } from "./errors.js";
import { resolveLocalFilePath } from "./push-helpers.js";
import { type ArchiveFileFingerprint, hashFileContents } from "./scan.js";
import type { LockstepPlan, PaneViewApi, PushStage } from "./types.js";

/** Every body a client posts to the Pane View sync API. */
type SyncRequestBody =
  | CompleteObjectRequest
  | CompleteSyncRunRequest
  | CreateSyncRunRequest
  | DeleteObjectRequest
  | UploadUrlRequest;

export type HashedMediaItem = MediaItem & { sha256: string };

/** Routes whose acknowledgement body is never read; only the HTTP status matters. */
const AcknowledgementSchema = z.unknown();

/** Streaming request bodies need undici's `duplex` flag, which `RequestInit` omits. */
interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

async function postJson<TSchema extends z.ZodType>(
  { apiToken, apiUrl }: PaneViewApi,
  route: string,
  body: SyncRequestBody,
  schema: TSchema,
  signal?: AbortSignal,
): Promise<z.output<TSchema>> {
  const response = await fetch(new URL(route, apiUrl), {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  });

  if (!response.ok) {
    throw new Error(`${route} failed with ${response.status}: ${await response.text()}`);
  }

  return schema.parse(await response.json());
}

/**
 * Hashes a local file that should still match `expected`, the fingerprint it was planned with;
 * throws when the file changes while it is read.
 */
export async function hashLocalFile(
  filePath: string,
  expected: ArchiveFileFingerprint,
  onProgress?: (bytesHashed: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return hashFileContents({
    expected,
    filePath,
    onProgress,
    operations: { createReadStream, stat },
    signal,
  });
}

export function uploadUrlBody(item: HashedMediaItem, logicalPath: string): UploadUrlRequest {
  const filename = getBaseName(logicalPath);

  return {
    contentType: contentTypeForExtension(getExtension(filename)),
    filename,
    sha256: item.sha256,
    size: item.size,
  };
}

export function completeObjectBody({
  item,
  logicalPath,
  objectKey,
  syncRunId,
}: {
  item: HashedMediaItem;
  logicalPath: string;
  objectKey: string;
  syncRunId: string;
}): CompleteObjectRequest {
  const { contentType, filename, sha256, size } = uploadUrlBody(item, logicalPath);
  const mediaType = ArchiveMediaTypeSchema.safeParse(item.mediaType);

  if (!mediaType.success) {
    throw new Error("unsupported media type");
  }

  return {
    contentType,
    extension: getExtension(filename),
    filename,
    logicalPath,
    mediaType: mediaType.data,
    mtimeMs: item.mtimeMs,
    objectKey,
    sha256,
    size,
    syncRunId,
  };
}

export function createSyncRunBody(plan: LockstepPlan): CreateSyncRunRequest {
  return { counts: plan.counts, sourceRoot: plan.sourceRoot };
}

/**
 * Uploads an item and registers it at `logicalPath`. For an update that is the existing remote
 * path when it differs only by case or the jpeg↔jpg alias, so the upsert hits the same library row
 * instead of inserting a twin.
 */
export async function pushMediaItem({
  api,
  item,
  logicalPath,
  onStage,
  signal,
  sourceRoot,
  syncRunId,
}: {
  api: PaneViewApi;
  item: HashedMediaItem;
  logicalPath: string;
  onStage: (stage: PushStage, bytes?: { done: number; total: number }) => void;
  signal?: AbortSignal;
  sourceRoot: string;
  syncRunId: string;
}): Promise<void> {
  const request = uploadUrlBody(item, logicalPath);

  onStage("registering");

  const target = await postJson(api, SYNC_ROUTES.uploadUrl, request, UploadTargetSchema, signal);

  await uploadFile({
    contentType: request.contentType,
    expectedSha256: item.sha256,
    expectedSize: item.size,
    filePath: resolveLocalFilePath(sourceRoot, item.path),
    headers: target.headers ?? {},
    onProgress: (done, total) => onStage("uploading", { done, total }),
    signal,
    uploadUrl: target.uploadUrl,
  });

  onStage("registering");
  await postJson(
    api,
    SYNC_ROUTES.completeObject,
    completeObjectBody({ item, logicalPath, objectKey: target.objectKey, syncRunId }),
    AcknowledgementSchema,
    signal,
  );
}

/**
 * How long run creation may still take once the caller cancels; it cannot be aborted outright,
 * since only the id it returns lets the run be finalized.
 */
export const CREATE_SYNC_RUN_CANCEL_GRACE_MS = 10_000;

/** Waits between finalization attempts; the server accepts an exact replay of the same outcome. */
export const FINALIZE_RETRY_DELAYS_MS = [250, 1000];

/**
 * How long one finalize attempt may take. A finalize is a single row update, so a slower answer
 * counts as a failed attempt and is retried.
 */
export const FINALIZE_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * How long a cancelled run may take to clean up: run creation's cancel grace, then every finalize
 * attempt and the waits between them.
 */
export const CANCELLED_RUN_CLEANUP_MS =
  CREATE_SYNC_RUN_CANCEL_GRACE_MS +
  FINALIZE_RETRY_DELAYS_MS.reduce((total, wait) => total + wait, 0) +
  (FINALIZE_RETRY_DELAYS_MS.length + 1) * FINALIZE_ATTEMPT_TIMEOUT_MS;

/**
 * Starts a sync run. The caller's abort signal does not abort the request: once it is sent the
 * server may commit the run, and only its id lets the caller finalize it. Uncancelled, creation
 * waits as long as the server takes (it can queue behind a library lock). After a cancel it gets
 * a bounded grace period to return the id, so the caller can finalize the run as cancelled.
 */
export async function createSyncRun({
  api,
  body,
  signal,
}: {
  api: PaneViewApi;
  body: CreateSyncRunRequest;
  signal?: AbortSignal;
}): Promise<z.output<typeof SyncRunSchema>> {
  const deadline = new AbortController();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const startGrace = () => {
    graceTimer = setTimeout(() => deadline.abort(), CREATE_SYNC_RUN_CANCEL_GRACE_MS);
  };

  if (signal?.aborted) {
    startGrace();
  } else {
    signal?.addEventListener("abort", startGrace, { once: true });
  }

  try {
    return await postJson(api, SYNC_ROUTES.runs, body, SyncRunSchema, deadline.signal);
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new Error(
        "Cancelled while Pane View was still creating the sync run, so it may be left running. " +
          "If Pane View's management page shows it running, cancel it there.",
        { cause: error },
      );
    }

    throw error;
  } finally {
    clearTimeout(graceTimer);
    signal?.removeEventListener("abort", startGrace);
  }
}

/**
 * Records a sync run's outcome, retrying a few times so a brief outage does not leave the run
 * marked running. No abort signal: a cancelled run still has to be finalized. Each attempt is
 * bounded, so the whole call fits `CANCELLED_RUN_CLEANUP_MS`. Returns the last error when every
 * attempt failed.
 */
export async function finalizeSyncRun({
  api,
  body,
  onRetry,
  syncRunId,
}: {
  api: PaneViewApi;
  body: CompleteSyncRunRequest;
  onRetry?: (error: Error) => void;
  syncRunId: string;
}): Promise<Error | undefined> {
  let lastError: Error | undefined;

  for (const retryDelay of [...FINALIZE_RETRY_DELAYS_MS, undefined]) {
    const timeout = AbortSignal.timeout(FINALIZE_ATTEMPT_TIMEOUT_MS);

    try {
      await postJson(api, completeSyncRunRoute(syncRunId), body, AcknowledgementSchema, timeout);

      return undefined;
    } catch (error) {
      lastError = timeout.aborted
        ? new Error(
            `Pane View did not answer within ${FINALIZE_ATTEMPT_TIMEOUT_MS / 1000} s while finalizing the sync run.`,
            { cause: error },
          )
        : toError(error);

      if (retryDelay === undefined) {
        break;
      }

      onRetry?.(lastError);
      await delay(retryDelay);
    }
  }

  return lastError;
}

export async function deleteRemoteItem({
  api,
  logicalPath,
  signal,
  syncRunId,
}: {
  api: PaneViewApi;
  logicalPath: string;
  signal?: AbortSignal;
  syncRunId: string;
}): Promise<void> {
  await postJson(
    api,
    SYNC_ROUTES.completeObject,
    { action: "delete", logicalPath, syncRunId },
    AcknowledgementSchema,
    signal,
  );
}

export async function uploadFile({
  contentType,
  expectedSha256,
  expectedSize,
  filePath,
  headers,
  onProgress,
  signal,
  uploadUrl,
}: {
  contentType: string;
  expectedSha256: string;
  expectedSize: number;
  filePath: string;
  headers: Record<string, string>;
  onProgress?: (bytesUploaded: number, total: number) => void;
  signal?: AbortSignal;
  uploadUrl: string;
}): Promise<void> {
  const fileStat = await stat(filePath);

  if (fileStat.size !== expectedSize) {
    throw new Error("File changed during sync; retry this item.");
  }

  const total = fileStat.size;
  let bytesUploaded = 0;
  const digest = createHash("sha256");
  const source = createReadStream(filePath);

  const body = new Transform({
    transform(chunk, _encoding, callback) {
      bytesUploaded += chunk.length;
      digest.update(chunk);
      onProgress?.(bytesUploaded, total);
      callback(null, chunk);
    },
  });

  // pipeline owns both streams: a read error (drive unplugged, file gone, access revoked) errors
  // the request body so fetch rejects, instead of escaping as an uncaught stream error. The read
  // error itself is what the caller sees, not fetch's generic body failure.
  let readError: Error | undefined;
  source.once("error", (error) => {
    readError = error;
  });
  pipeline(source, body, () => {});

  const destroyStreams = () => {
    if (!source.destroyed) {
      source.destroy();
    }

    if (!body.destroyed) {
      body.destroy();
    }
  };

  const onAbort = () => {
    destroyStreams();
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) {
      throw new Error("Upload aborted.");
    }

    // SAFETY: `Readable.toWeb` returns a WHATWG ReadableStream, which fetch accepts as a
    // streaming body; only the node:stream/web and DOM declarations of that class differ.
    const request: StreamingRequestInit = {
      body: Readable.toWeb(body) as BodyInit,
      duplex: "half",
      headers: {
        ...headers,
        "Content-Length": headers["Content-Length"] ?? String(total),
        "Content-Type": headers["Content-Type"] ?? contentType,
      },
      method: "PUT",
      signal,
    };

    const response = await fetch(uploadUrl, request);

    if (!response.ok) {
      throw new Error(`Upload failed with ${response.status}: ${await response.text()}`);
    }

    if (bytesUploaded !== expectedSize) {
      throw new Error("Uploaded byte count does not match declared size.");
    }

    const uploadedSha256 = digest.digest("hex");

    if (uploadedSha256 !== expectedSha256.toLowerCase()) {
      throw new Error("Uploaded bytes do not match declared sha256.");
    }

    onProgress?.(total, total);
  } catch (error) {
    destroyStreams();
    throw readError ?? error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    destroyStreams();
  }
}
