import {
  getBaseName,
  getExtension,
  isSupportedMediaFile,
  type MediaType,
  toArchivePath,
  trimTrailingSlash,
} from "@latch-works/media-domain";
import { originalObjectKey } from "@latch-works/media-storage";

export interface SyncObjectPayload {
  contentType: string;
  extension: string;
  filename: string;
  logicalPath: string;
  mediaType: MediaType;
  mtimeMs: number;
  objectKey: string;
  sha256: string;
  size: number;
  syncRunId: string;
}

export type SyncObjectValidationResult =
  | { ok: true; input: SyncObjectPayload }
  | { ok: false; error: string };

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/** S3 single-PUT object size limit (multipart required above this). */
export const MAX_SYNC_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export function validateUploadSize(size: unknown): string | null {
  if (size === undefined || size === null) {
    return "size is required";
  }

  const parsed = Math.trunc(Number(size));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return "size must be a non-negative safe integer";
  }

  if (parsed > MAX_SYNC_UPLOAD_BYTES) {
    return `size must not exceed ${MAX_SYNC_UPLOAD_BYTES} bytes`;
  }

  return null;
}

export function expectedContentTypeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
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

export function validateSyncContentType(extension: string, contentType: string): string | null {
  const expected = expectedContentTypeForExtension(extension);
  if (contentType !== expected) {
    return "contentType does not match extension";
  }

  return null;
}

export function validateSyncObjectPayload(
  body: Record<string, unknown>,
): SyncObjectValidationResult {
  const required = [
    "contentType",
    "extension",
    "filename",
    "logicalPath",
    "mediaType",
    "mtimeMs",
    "sha256",
    "size",
    "syncRunId",
  ] as const;

  for (const key of required) {
    if (body[key] === undefined) {
      return { ok: false, error: `${key} is required` };
    }
  }

  const mediaType = String(body.mediaType);
  if (mediaType === "unknown") {
    return { ok: false, error: "unsupported media type" };
  }

  if (!["image", "gif", "video", "pdf"].includes(mediaType)) {
    return { ok: false, error: "mediaType is invalid" };
  }

  const sha256 = String(body.sha256);
  if (!SHA256_PATTERN.test(sha256)) {
    return { ok: false, error: "sha256 must be a 64-character hex string" };
  }

  const logicalPath = normalizeSyncLogicalPath(String(body.logicalPath));
  const pathError = validateSyncLogicalPath(logicalPath);
  if (pathError) {
    return { ok: false, error: pathError };
  }

  const filename = String(body.filename);
  const derivedFilename = getBaseName(logicalPath);
  if (filename !== derivedFilename) {
    return { ok: false, error: "filename must match logicalPath" };
  }

  const extension = String(body.extension);
  const derivedExtension = getExtension(filename);
  if (extension !== derivedExtension) {
    return { ok: false, error: "extension must match filename" };
  }

  if (!isSupportedMediaFile(filename)) {
    return { ok: false, error: "unsupported media filename" };
  }

  const mtimeMs = Math.trunc(Number(body.mtimeMs));
  const size = Math.trunc(Number(body.size));
  if (!Number.isSafeInteger(mtimeMs) || !Number.isSafeInteger(size) || size < 0) {
    return { ok: false, error: "mtimeMs and size must be valid integers" };
  }

  const sizeError = validateUploadSize(size);
  if (sizeError) {
    return { ok: false, error: sizeError };
  }

  const derivedObjectKey = originalObjectKey({
    extension,
    sha256,
  });
  const objectKey = typeof body.objectKey === "string" ? body.objectKey : derivedObjectKey;
  if (objectKey !== derivedObjectKey) {
    return { ok: false, error: "objectKey does not match derived storage key" };
  }

  const contentType = String(body.contentType);
  const contentTypeError = validateSyncContentType(extension, contentType);
  if (contentTypeError) {
    return { ok: false, error: contentTypeError };
  }

  return {
    ok: true,
    input: {
      contentType: expectedContentTypeForExtension(extension),
      extension,
      filename,
      logicalPath,
      mediaType: mediaType as MediaType,
      mtimeMs,
      objectKey: derivedObjectKey,
      sha256,
      size,
      syncRunId: String(body.syncRunId),
    },
  };
}

export function normalizeSyncLogicalPath(path: string): string {
  return trimTrailingSlash(toArchivePath(path));
}

export function validateSyncLogicalPath(logicalPath: string): string | null {
  if (!logicalPath) {
    return "logicalPath must not be empty";
  }

  if (logicalPath.startsWith("/")) {
    return "logicalPath must be a relative archive path";
  }

  if (logicalPath.endsWith("/")) {
    return "logicalPath must not end with a slash";
  }

  if (logicalPath.split("/").some((segment) => segment === "..")) {
    return "logicalPath must not contain parent segments";
  }

  return null;
}

export function validateUploadFilename(filename: string): string | null {
  if (!filename) {
    return "filename is required";
  }

  if (!isSupportedMediaFile(filename)) {
    return "unsupported media filename";
  }

  return null;
}
