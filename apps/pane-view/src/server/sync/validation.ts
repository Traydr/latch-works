import {
  canonicalizeExtension,
  getBaseName,
  getExtension,
  isSupportedMediaFile,
  type MediaType,
  toArchivePath,
  trimTrailingSlash,
} from "@latch-works/media-domain";
import { originalObjectKey } from "@latch-works/media-storage";
import { z } from "zod";
import type { JsonValue } from "@/lib/json";
import { describeFirstIssue } from "../http/json-body";

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

/** Per-action counts a sync run reports (`upload`, `keep`, ...); stored as jsonb. */
export const SyncRunCountsSchema = z.record(z.string(), z.number(), {
  error: "counts must be an object of numbers",
});

/** A JSON number the client may send with a fractional part (fs mtimes); stored truncated. */
const truncatedSafeIntegerSchema = (label: string) =>
  z
    .number({ error: `${label} must be a valid integer` })
    .transform(Math.trunc)
    .refine(Number.isSafeInteger, `${label} must be a valid integer`);

/** Declared upload size: required, a non-negative safe integer, within the single-PUT limit. */
export const UploadSizeSchema = z
  .number({
    error: (issue) =>
      issue.input === undefined || issue.input === null
        ? "size is required"
        : "size must be a non-negative safe integer",
  })
  .transform(Math.trunc)
  .refine(
    (size) => Number.isSafeInteger(size) && size >= 0,
    "size must be a non-negative safe integer",
  )
  .refine(
    (size) => size <= MAX_SYNC_UPLOAD_BYTES,
    `size must not exceed ${MAX_SYNC_UPLOAD_BYTES} bytes`,
  );

/**
 * The declared fields of a completed-object payload, in the order their
 * errors are reported. Cross-field rules (filename vs. logicalPath, derived
 * object key, content type) follow in validateSyncObjectPayload.
 */
export const SyncObjectPayloadBodySchema = z.object({
  mediaType: z.enum(["image", "gif", "video", "pdf"], {
    error: (issue) =>
      issue.input === "unknown" ? "unsupported media type" : "mediaType is invalid",
  }),
  sha256: z.string({ error: "sha256 is required" }).regex(SHA256_PATTERN, {
    error: "sha256 must be a 64-character hex string",
  }),
  logicalPath: z.string({ error: "logicalPath is required" }),
  filename: z.string({ error: "filename is required" }),
  extension: z.string({ error: "extension is required" }),
  mtimeMs: truncatedSafeIntegerSchema("mtimeMs"),
  size: UploadSizeSchema,
  objectKey: z.string({ error: "objectKey must be a string" }).optional(),
  contentType: z.string({ error: "contentType is required" }),
  syncRunId: z.string({ error: "syncRunId is required" }),
});

export type SyncObjectPayloadBody = z.infer<typeof SyncObjectPayloadBodySchema>;

/** The complete-object route body: a remote delete, or (the default) an uploaded object. */
export const CompleteObjectBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("delete"),
    logicalPath: z.string({ error: "logicalPath and syncRunId are required" }),
    syncRunId: z.string({ error: "logicalPath and syncRunId are required" }),
  }),
  SyncObjectPayloadBodySchema.extend({ action: z.literal("upload").optional() }),
]);

/** Parse a raw completed-object payload and apply the cross-field rules. */
export function parseSyncObjectPayload(raw: JsonValue): SyncObjectValidationResult {
  const parsed = SyncObjectPayloadBodySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: describeFirstIssue(parsed.error) };
  }
  return validateSyncObjectPayload(parsed.data);
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

export function validateSyncObjectPayload(body: SyncObjectPayloadBody): SyncObjectValidationResult {
  const logicalPath = normalizeSyncLogicalPath(body.logicalPath);
  const pathError = validateSyncLogicalPath(logicalPath);
  if (pathError) {
    return { ok: false, error: pathError };
  }

  const filename = body.filename;
  const derivedFilename = getBaseName(logicalPath);
  if (filename !== derivedFilename) {
    return { ok: false, error: "filename must match logicalPath" };
  }

  const extension = canonicalizeExtension(body.extension);
  const derivedExtension = getExtension(filename);
  if (extension !== derivedExtension) {
    return { ok: false, error: "extension must match filename" };
  }

  if (!isSupportedMediaFile(filename)) {
    return { ok: false, error: "unsupported media filename" };
  }

  const derivedObjectKey = originalObjectKey({
    extension,
    sha256: body.sha256,
  });
  const objectKey = body.objectKey ?? derivedObjectKey;
  if (objectKey !== derivedObjectKey) {
    return { ok: false, error: "objectKey does not match derived storage key" };
  }

  const contentTypeError = validateSyncContentType(extension, body.contentType);
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
      mediaType: body.mediaType,
      mtimeMs: body.mtimeMs,
      objectKey: derivedObjectKey,
      sha256: body.sha256,
      size: body.size,
      syncRunId: body.syncRunId,
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
