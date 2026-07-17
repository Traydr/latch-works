import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import type { MediaItem } from "@latch-works/media-domain";
import { hashFileContents } from "@latch-works/media-index";
import { formatBytes } from "./format.js";
import { resolveLocalFilePath } from "./push-helpers.js";

export type PushStage = "deleting" | "hashing" | "registering" | "uploading";

export async function postJson<T = unknown>(
  apiUrl: string,
  route: string,
  apiToken: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
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

  return (await response.json()) as T;
}

export async function hashLocalFile(
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

export async function pushMediaItem({
  apiToken,
  apiUrl,
  item,
  onStage,
  signal,
  sourceRoot,
  syncRunId,
}: {
  apiToken: string;
  apiUrl: string;
  item: MediaItem;
  onStage: (stage: PushStage, detail?: string) => void;
  signal?: AbortSignal;
  sourceRoot: string;
  syncRunId: string;
}): Promise<void> {
  const filePath = resolveLocalFilePath(sourceRoot, item.path);
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
  const uploadTarget = await postJson<{
    headers?: Record<string, string>;
    objectKey: string;
    uploadUrl: string | null;
  }>(
    apiUrl,
    "/api/sync/upload-url",
    apiToken,
    {
      contentType: contentTypeFor(item),
      filename: item.name,
      sha256,
      size: preHashStat.size,
    },
    signal,
  );

  if (uploadTarget.uploadUrl) {
    await uploadFile({
      contentType: contentTypeFor(item),
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
      contentType: contentTypeFor(item),
      extension: item.extension,
      filename: item.name,
      logicalPath: item.path,
      mediaType: item.mediaType,
      mtimeMs: item.mtimeMs,
      objectKey: uploadTarget.objectKey,
      sha256,
      size: preHashStat.size,
      syncRunId,
    },
    signal,
  );
}

export async function deleteRemoteItem({
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

    const response = await fetch(uploadUrl, {
      body: Readable.toWeb(body) as BodyInit,
      duplex: "half",
      headers: {
        ...headers,
        "Content-Length": headers["Content-Length"] ?? String(total),
        "Content-Type": headers["Content-Type"] ?? contentType,
      },
      method: "PUT",
      signal,
    } as RequestInit & { duplex: "half" });

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

function contentTypeFor(item: MediaItem): string {
  switch (item.extension) {
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
