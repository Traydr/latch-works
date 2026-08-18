import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { getBaseName, getExtension, type MediaItem } from "@latch-works/media-domain";
import { hashFileContents } from "@latch-works/media-index";
import { z } from "zod";
import { formatBytes } from "./format.js";
import { resolveLocalFilePath } from "./push-helpers.js";
import type { LockstepPlanCounts } from "./types.js";

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
export const AcknowledgementSchema = z.unknown();

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
  const body = source.pipe(
    new Transform({
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
    }),
  );

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
    throw error;
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
