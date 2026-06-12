import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import type { MediaItem } from "@latch-works/media-domain";
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
  const hash = createHash("sha256");
  let bytesHashed = 0;
  let lastReport = 0;

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const stream = createReadStream(filePath);
    const onAbort = () => {
      stream.destroy(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytesHashed += chunk.length;

      const now = Date.now();
      if (now - lastReport >= 100) {
        lastReport = now;
        onProgress?.(bytesHashed, fileStat.size);
      }
    });
    stream.on("error", reject);
    stream.on("end", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });

  onProgress?.(fileStat.size, fileStat.size);
  return hash.digest("hex");
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
    },
    signal,
  );

  if (uploadTarget.uploadUrl) {
    await uploadFile(
      uploadTarget.uploadUrl,
      filePath,
      contentTypeFor(item),
      (bytesUploaded, total) => {
        onStage("uploading", `${formatBytes(bytesUploaded)} / ${formatBytes(total)}`);
      },
      signal,
    );
  } else {
    onStage("uploading", "skipped (storage not configured)");
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
      size: item.size,
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

async function uploadFile(
  uploadUrl: string,
  filePath: string,
  contentType: string,
  onProgress?: (bytesUploaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const fileStat = await stat(filePath);
  const total = fileStat.size;
  let bytesUploaded = 0;
  let lastReport = 0;

  const body = createReadStream(filePath).pipe(
    new Transform({
      transform(chunk, _encoding, callback) {
        bytesUploaded += chunk.length;
        const now = Date.now();
        if (onProgress && now - lastReport >= 100) {
          lastReport = now;
          onProgress(bytesUploaded, total);
        }
        callback(null, chunk);
      },
    }),
  );

  const response = await fetch(uploadUrl, {
    body: Readable.toWeb(body) as BodyInit,
    duplex: "half",
    headers: {
      "Content-Length": String(total),
      "Content-Type": contentType,
    },
    method: "PUT",
    signal,
  } as RequestInit & { duplex: "half" });

  if (!response.ok) {
    throw new Error(`Upload failed with ${response.status}: ${await response.text()}`);
  }

  onProgress?.(total, total);
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
