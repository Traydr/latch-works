import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline, Readable, Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { getBaseName, getExtension, type MediaItem } from "@latch-works/media-domain";
import { hashFileContents } from "@latch-works/media-index";
import { z } from "zod";
import { formatBytes, formatPushError, toError } from "./format.js";
import { resolveLocalFilePath } from "./push-helpers.js";
import type { LockstepObserver, LockstepPlanCounts } from "./types.js";

type PushStage = "deleting" | "hashing" | "registering" | "uploading";

interface CreateSyncRunRequest {
  counts: LockstepPlanCounts;
  sourceRoot: string;
}

interface SyncRunOutcomeCounts extends LockstepPlanCounts {
  capped: number;
  failed: number;
  planned: number;
  pushed: number;
}

interface CompleteSyncRunRequest {
  counts: SyncRunOutcomeCounts;
  error: string | undefined;
  status: "cancelled" | "completed" | "failed";
}

interface UploadUrlRequest {
  contentType: string;
  filename: string;
  sha256: string;
  size: number;
}

interface CompleteObjectRequest {
  contentType: string;
  extension: string;
  filename: string;
  logicalPath: string;
  mediaType: MediaItem["mediaType"];
  mtimeMs: number;
  objectKey: string;
  sha256: string;
  size: number;
  syncRunId: string;
}

interface DeleteObjectRequest {
  action: "delete";
  logicalPath: string;
  syncRunId: string;
}

/** Every body this client posts to the Pane View sync API. */
export type SyncRequestBody =
  | CompleteObjectRequest
  | CompleteSyncRunRequest
  | CreateSyncRunRequest
  | DeleteObjectRequest
  | UploadUrlRequest;

export const SyncRunSchema = z.object({ syncRunId: z.string() });

const UploadTargetSchema = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  objectKey: z.string(),
  uploadUrl: z.string().nullable(),
});

/** Routes whose acknowledgement body is never read; only the HTTP status matters. */
const AcknowledgementSchema = z.unknown();

/** Streaming request bodies need undici's `duplex` flag, which `RequestInit` omits. */
interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

async function postJson<TSchema extends z.ZodType>(
  apiUrl: string,
  route: string,
  apiToken: string,
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

async function hashLocalFile(
  filePath: string,
  onProgress?: (bytesHashed: number, fileSize: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const fileStat = await stat(filePath);
  let lastReport = 0;

  const sha256 = await hashFileContents({
    expected: {
      ctimeMs: fileStat.ctimeMs,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    },
    filePath,
    onProgress: (bytesHashed) => {
      const now = Date.now();

      if (now - lastReport >= 100) {
        lastReport = now;
        onProgress?.(bytesHashed, fileStat.size);
      }
    },
    operations: { createReadStream, stat },
    signal,
  });

  onProgress?.(fileStat.size, fileStat.size);

  return sha256;
}

async function pushMediaItem({
  apiToken,
  apiUrl,
  item,
  /**
   * Library path to register. For updates, pass the existing remote path when it only
   * differs by case/extension alias so upsert hits the same row instead of inserting a twin.
   */
  logicalPath = item.path,
  onStage,
  signal,
  sourceRoot,
  syncRunId,
}: {
  apiToken: string;
  apiUrl: string;
  item: MediaItem;
  logicalPath?: string;
  onStage: (stage: PushStage, detail?: string) => void;
  signal?: AbortSignal;
  sourceRoot: string;
  syncRunId: string;
}): Promise<void> {
  const filePath = resolveLocalFilePath(sourceRoot, item.path);
  const registrationName = getBaseName(logicalPath);
  const registrationExtension = getExtension(registrationName);
  const contentType = contentTypeForExtension(registrationExtension);
  const preHashStat = await stat(filePath);

  const sha256 =
    item.sha256 ??
    (await hashLocalFile(
      filePath,
      (bytesHashed, fileSize) => {
        onStage("hashing", `${formatBytes(bytesHashed)} / ${formatBytes(fileSize)}`);
      },
      signal,
    ));

  onStage("registering", "requesting upload URL");

  const uploadTarget = await postJson(
    apiUrl,
    "/api/sync/upload-url",
    apiToken,
    {
      contentType,
      filename: registrationName,
      sha256,
      size: preHashStat.size,
    },
    UploadTargetSchema,
    signal,
  );

  if (uploadTarget.uploadUrl) {
    await uploadFile({
      contentType,
      expectedSha256: sha256,
      expectedSize: preHashStat.size,
      filePath,
      headers: uploadTarget.headers ?? {},
      onProgress: (bytesUploaded, total) => {
        onStage("uploading", `${formatBytes(bytesUploaded)} / ${formatBytes(total)}`);
      },
      signal,
      uploadUrl: uploadTarget.uploadUrl,
    });
  } else {
    onStage("uploading", "skipped (storage not configured)");
  }

  const postUploadStat = await stat(filePath);

  if (postUploadStat.size !== preHashStat.size || postUploadStat.mtimeMs !== preHashStat.mtimeMs) {
    throw new Error("File changed during sync; retry this item.");
  }

  onStage("registering", "recording ingest");
  await postJson(
    apiUrl,
    "/api/sync/complete-object",
    apiToken,
    {
      contentType,
      extension: registrationExtension,
      filename: registrationName,
      logicalPath,
      mediaType: item.mediaType,
      mtimeMs: item.mtimeMs,
      objectKey: uploadTarget.objectKey,
      sha256,
      size: preHashStat.size,
      syncRunId,
    },
    AcknowledgementSchema,
    signal,
  );
}

/** How long run creation may take; it cannot be cancelled, so it must not hang a cancelled run. */
const CREATE_SYNC_RUN_TIMEOUT_MS = 10_000;

/**
 * Starts a sync run. Deliberately ignores the caller's abort signal: once the request is sent the
 * server may commit the run, and only its id lets the caller finalize it, so a cancelled caller
 * waits (bounded) for the id and then finalizes the run as cancelled instead of stranding it.
 */
export function createSyncRun({
  apiToken,
  apiUrl,
  body,
  postJson: post,
}: {
  apiToken: string;
  apiUrl: string;
  body: CreateSyncRunRequest;
  postJson: typeof postJson;
}): Promise<z.output<typeof SyncRunSchema>> {
  return post(
    apiUrl,
    "/api/sync/runs",
    apiToken,
    body,
    SyncRunSchema,
    AbortSignal.timeout(CREATE_SYNC_RUN_TIMEOUT_MS),
  );
}

/** Waits between finalization attempts; the server accepts an exact replay of the same outcome. */
const FINALIZE_RETRY_DELAYS_MS = [250, 1000];

/**
 * Records a sync run's outcome, retrying a few times so a brief outage does not leave the run
 * marked running. No abort signal: a cancelled run still has to be finalized. Returns the last
 * error when every attempt failed.
 */
export async function finalizeSyncRun({
  apiToken,
  apiUrl,
  body,
  onRetry,
  postJson: post,
  syncRunId,
}: {
  apiToken: string;
  apiUrl: string;
  body: CompleteSyncRunRequest;
  onRetry?: (error: Error) => void;
  postJson: typeof postJson;
  syncRunId: string;
}): Promise<Error | undefined> {
  let lastError: Error | undefined;

  for (const retryDelay of [...FINALIZE_RETRY_DELAYS_MS, undefined]) {
    try {
      await post(
        apiUrl,
        `/api/sync/runs/${syncRunId}/complete`,
        apiToken,
        body,
        AcknowledgementSchema,
      );

      return undefined;
    } catch (error) {
      lastError = toError(error);

      if (retryDelay === undefined) {
        break;
      }

      onRetry?.(lastError);
      await delay(retryDelay);
    }
  }

  return lastError;
}

/** The status a sync run was meant to be recorded with when finalization failed. */
export type SyncRunOutcomeStatus = CompleteSyncRunRequest["status"];

/**
 * Every finalization attempt failed, so Pane View still shows the run as running and blocks
 * library maintenance until it is cancelled on the management page. Thrown by push and prune in
 * place of whatever else ended the run: `cause` is the cancellation reason or fatal error when
 * there was one, and the finalization error otherwise. `intendedStatus` says which.
 */
export class UnfinalizedSyncRunError extends Error {
  readonly action: "prune" | "push";
  readonly finalizeError: Error;
  readonly intendedStatus: SyncRunOutcomeStatus;
  readonly syncRunId: string;

  constructor({
    action,
    cause,
    finalizeError,
    intendedStatus,
    message,
    syncRunId,
  }: {
    action: "prune" | "push";
    cause: unknown;
    finalizeError: Error;
    intendedStatus: SyncRunOutcomeStatus;
    message: string;
    syncRunId: string;
  }) {
    super(message, { cause });
    this.name = "UnfinalizedSyncRunError";
    this.action = action;
    this.finalizeError = finalizeError;
    this.intendedStatus = intendedStatus;
    this.syncRunId = syncRunId;
  }
}

/**
 * The server still has the run marked running. Reports the run as failed, naming it so it can be
 * cancelled in Pane View's management page, and returns the error to throw. `interruption` is
 * what ended the run early, if anything: a cancellation or a fatal error.
 */
export function failUnfinalizedRun({
  action,
  done,
  failed,
  finalizeError,
  interruption,
  observer,
  planCounts,
  pushed,
  skipped,
  syncRunId,
}: {
  action: "prune" | "push";
  done: string;
  failed: number;
  finalizeError: Error;
  interruption?: { error: Error; status: "failed" } | { reason: unknown; status: "cancelled" };
  observer?: LockstepObserver;
  planCounts: LockstepPlanCounts;
  pushed: number;
  skipped?: number;
  syncRunId: string;
}): UnfinalizedSyncRunError {
  const outcome =
    interruption?.status === "cancelled"
      ? `Run cancelled after ${done}`
      : interruption?.status === "failed"
        ? `${interruption.error.message} Stopped after ${done}`
        : done;

  const message =
    `${outcome}, but sync run ${syncRunId} could not be finalized: ${formatPushError(finalizeError)}. ` +
    "Pane View shows it as running until it is cancelled on the management page.";

  observer?.onEvent({
    type: "complete",
    summary: {
      action,
      completedAt: new Date().toISOString(),
      failed,
      message,
      planCounts,
      pushed,
      skipped,
      status: "failed",
    },
  });

  return new UnfinalizedSyncRunError({
    action,
    cause:
      interruption?.status === "cancelled"
        ? interruption.reason
        : interruption?.status === "failed"
          ? interruption.error
          : finalizeError,
    finalizeError,
    intendedStatus: interruption?.status ?? (failed > 0 ? "failed" : "completed"),
    message,
    syncRunId,
  });
}

async function deleteRemoteItem({
  apiToken,
  apiUrl,
  logicalPath,
  signal,
  syncRunId,
}: {
  apiToken: string;
  apiUrl: string;
  logicalPath: string;
  signal?: AbortSignal;
  syncRunId: string;
}): Promise<void> {
  await postJson(
    apiUrl,
    "/api/sync/complete-object",
    apiToken,
    {
      action: "delete",
      logicalPath,
      syncRunId,
    },
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
  let lastReport = 0;
  const digest = createHash("sha256");
  const source = createReadStream(filePath);

  const body = new Transform({
    transform(chunk, _encoding, callback) {
      bytesUploaded += chunk.length;
      digest.update(chunk);
      const now = Date.now();

      if (onProgress && now - lastReport >= 100) {
        lastReport = now;
        onProgress(bytesUploaded, total);
      }

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

function contentTypeForExtension(extension: string): string {
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

/** Remote calls `pushChanges` makes, injectable so tests can drive a faithful fake. */
export interface PushRemoteApi {
  hashLocalFile: typeof hashLocalFile;
  postJson: typeof postJson;
  pushMediaItem: typeof pushMediaItem;
}

/** Remote calls `pruneDeleted` makes, injectable so tests can drive a faithful fake. */
export interface PruneRemoteApi {
  deleteRemoteItem: typeof deleteRemoteItem;
  postJson: typeof postJson;
}

export const remoteApi = {
  deleteRemoteItem,
  hashLocalFile,
  postJson,
  pushMediaItem,
} satisfies PruneRemoteApi & PushRemoteApi;
