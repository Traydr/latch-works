/*
 * Pane View's reading of the sync request bodies. Each schema extends the shape the Lockstep
 * clients send (`@latch-works/sync-protocol`) with the server's stricter checks and the error
 * texts its 400 answers carry; the clients' own wire vectors (wire.json) must all pass.
 */
import {
  canonicalizeExtension,
  getBaseName,
  getExtension,
  isSupportedMediaFile,
  toArchivePath,
  trimTrailingSlash,
} from "@latch-works/media-domain";
import {
  ArchiveMediaTypeSchema,
  CompleteObjectRequestSchema,
  CompleteSyncRunRequestSchema,
  CreateSyncRunRequestSchema,
  contentTypeForExtension,
  DeleteObjectRequestSchema,
  MAX_SYNC_UPLOAD_BYTES,
  originalObjectKey,
  SHA256_PATTERN,
  SyncRunStatusSchema,
  UploadUrlRequestSchema,
} from "@latch-works/sync-protocol";
import { z } from "zod";
import type { JsonValue } from "@/lib/json";
import type { CompleteObjectInput, RemoteDeleteInput } from "./store";
import type { FinalizeSyncRunBody, StartSyncRunInput } from "./sync-runs";

export type ParsedSyncBody<Body> = { ok: true; body: Body } | { ok: false; error: string };

/** Pane View stores whatever counts a client reports and shows them as they are. */
const SyncRunCountsSchema = z.record(z.string(), z.number(), {
  error: "counts must be an object of numbers",
});

/** A sync run id: a UUID, so a malformed one is a bad request rather than a database error. */
const syncRunIdSchema = (requiredMessage: string) =>
  z.uuid({
    error: (issue) =>
      issue.input === undefined || issue.input === null
        ? requiredMessage
        : "syncRunId must be a UUID",
  });

/** A JSON number the client may send with a fractional part (fs mtimes); stored truncated. */
const truncatedSafeIntegerSchema = (label: string) =>
  z
    .number({ error: `${label} must be a valid integer` })
    .transform(Math.trunc)
    .refine(Number.isSafeInteger, `${label} must be a valid integer`);

const uploadSizeSchema = z
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

const SHA256_ERROR = "sha256 must be a 64-character hex string";

const UploadUrlBodySchema = UploadUrlRequestSchema.extend({
  filename: z.string({ error: "filename and sha256 are required" }).min(1, {
    error: "filename and sha256 are required",
  }),
  sha256: z
    .string({ error: "filename and sha256 are required" })
    .min(1, { error: "filename and sha256 are required" })
    .regex(SHA256_PATTERN, { error: SHA256_ERROR }),
  size: uploadSizeSchema,
  contentType: z.string({ error: "contentType is required" }),
});

const UploadedObjectBodySchema = CompleteObjectRequestSchema.extend({
  action: z.literal("upload").optional(),
  mediaType: z.enum(ArchiveMediaTypeSchema.options, {
    error: (issue) =>
      issue.input === "unknown" ? "unsupported media type" : "mediaType is invalid",
  }),
  // One content hash, one spelling: the storage key is derived from the lowercase hash, so a
  // second spelling must not become a second media object.
  sha256: z
    .string({ error: "sha256 is required" })
    .regex(SHA256_PATTERN, { error: SHA256_ERROR })
    .transform((sha256) => sha256.toLowerCase()),
  logicalPath: z.string({ error: "logicalPath is required" }),
  filename: z.string({ error: "filename is required" }),
  extension: z.string({ error: "extension is required" }),
  mtimeMs: truncatedSafeIntegerSchema("mtimeMs"),
  size: uploadSizeSchema,
  objectKey: z.string({ error: "objectKey is required" }),
  contentType: z.string({ error: "contentType is required" }),
  syncRunId: syncRunIdSchema("syncRunId is required"),
});

const RemoteDeleteBodySchema = DeleteObjectRequestSchema.extend({
  logicalPath: z.string({ error: "logicalPath and syncRunId are required" }),
  syncRunId: syncRunIdSchema("logicalPath and syncRunId are required"),
});

/** A remote delete, or (without `action`) an uploaded object. */
const CompleteObjectBodySchema = z.discriminatedUnion("action", [
  RemoteDeleteBodySchema,
  UploadedObjectBodySchema,
]);

const CreateSyncRunBodySchema = CreateSyncRunRequestSchema.extend({
  counts: SyncRunCountsSchema,
  sourceRoot: z.string({ error: "sourceRoot must be a string" }),
});

const FinalizeSyncRunBodySchema = CompleteSyncRunRequestSchema.extend({
  counts: SyncRunCountsSchema,
  error: z.string({ error: "error must be a string" }).optional(),
  status: z.enum(SyncRunStatusSchema.options, {
    error: "status must be completed, failed, or cancelled",
  }),
});

/**
 * The first issue as one line. Top-level fields carry messages that name themselves; nested
 * paths (record entries) are prefixed.
 */
function describeFirstIssue(error: z.ZodError): string {
  const issue = error.issues[0];

  if (!issue) {
    return "invalid request body";
  }

  return issue.path.length > 1
    ? `${issue.path.map(String).join(".")}: ${issue.message}`
    : issue.message;
}

function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  json: JsonValue,
): ParsedSyncBody<z.output<Schema>> {
  const result = schema.safeParse(json);

  return result.success
    ? { ok: true, body: result.data }
    : { ok: false, error: describeFirstIssue(result.error) };
}

function contentTypeError(extension: string, contentType: string): string | null {
  return contentType === contentTypeForExtension(extension)
    ? null
    : "contentType does not match extension";
}

/** A logical path as the archive stores it, or why the archive cannot hold it. */
export function parseSyncLogicalPath(path: string): ParsedSyncBody<string> {
  const logicalPath = trimTrailingSlash(toArchivePath(path));

  if (!logicalPath) {
    return { ok: false, error: "logicalPath must not be empty" };
  }

  if (logicalPath.split("/").some((segment) => segment === "..")) {
    return { ok: false, error: "logicalPath must not contain parent segments" };
  }

  return { ok: true, body: logicalPath };
}

/** What `POST /api/sync/upload-url` signs: the derived object key and the content type. */
export interface UploadTargetInput {
  contentType: string;
  objectKey: string;
  sha256: string;
  size: number;
}

export function parseUploadUrlBody(json: JsonValue): ParsedSyncBody<UploadTargetInput> {
  const parsed = parseWith(UploadUrlBodySchema, json);

  if (!parsed.ok) return parsed;

  const { contentType, filename, sha256, size } = parsed.body;

  if (!isSupportedMediaFile(filename)) {
    return { ok: false, error: "unsupported media filename" };
  }

  const extension = getExtension(filename);
  const error = contentTypeError(extension, contentType);

  if (error) return { ok: false, error };

  return {
    ok: true,
    body: {
      contentType,
      objectKey: originalObjectKey({ extension, sha256 }),
      sha256,
      size,
    },
  };
}

export type CompleteObjectBody =
  | ({ action: "delete" } & RemoteDeleteInput)
  | ({ action: "upload" } & CompleteObjectInput);

function validateUploadedObject(
  body: z.output<typeof UploadedObjectBodySchema>,
): ParsedSyncBody<CompleteObjectInput> {
  const path = parseSyncLogicalPath(body.logicalPath);

  if (!path.ok) return path;

  const logicalPath = path.body;
  const filename = body.filename;

  if (filename !== getBaseName(logicalPath)) {
    return { ok: false, error: "filename must match logicalPath" };
  }

  const extension = canonicalizeExtension(body.extension);

  if (extension !== getExtension(filename)) {
    return { ok: false, error: "extension must match filename" };
  }

  if (!isSupportedMediaFile(filename)) {
    return { ok: false, error: "unsupported media filename" };
  }

  const objectKey = originalObjectKey({ extension, sha256: body.sha256 });

  if (body.objectKey !== objectKey) {
    return { ok: false, error: "objectKey does not match derived storage key" };
  }

  const error = contentTypeError(extension, body.contentType);

  if (error) return { ok: false, error };

  return {
    ok: true,
    body: {
      contentType: body.contentType,
      extension,
      filename,
      logicalPath,
      mediaType: body.mediaType,
      mtimeMs: body.mtimeMs,
      objectKey,
      sha256: body.sha256,
      size: body.size,
      syncRunId: body.syncRunId,
    },
  };
}

export function parseCompleteObjectBody(json: JsonValue): ParsedSyncBody<CompleteObjectBody> {
  const parsed = parseWith(CompleteObjectBodySchema, json);

  if (!parsed.ok) return parsed;

  if (parsed.body.action === "delete") {
    const path = parseSyncLogicalPath(parsed.body.logicalPath);

    if (!path.ok) return path;

    return {
      ok: true,
      body: { action: "delete", logicalPath: path.body, syncRunId: parsed.body.syncRunId },
    };
  }

  const upload = validateUploadedObject(parsed.body);

  return upload.ok ? { ok: true, body: { action: "upload", ...upload.body } } : upload;
}

export function parseCreateSyncRunBody(json: JsonValue): ParsedSyncBody<StartSyncRunInput> {
  const parsed = parseWith(CreateSyncRunBodySchema, json);

  if (!parsed.ok) return parsed;

  return { ok: true, body: { counts: parsed.body.counts, sourceRoot: parsed.body.sourceRoot } };
}

export function parseFinalizeSyncRunBody(json: JsonValue): ParsedSyncBody<FinalizeSyncRunBody> {
  const parsed = parseWith(FinalizeSyncRunBodySchema, json);

  if (!parsed.ok) return parsed;

  return {
    ok: true,
    body: {
      counts: parsed.body.counts,
      error: parsed.body.error ?? null,
      status: parsed.body.status,
    },
  };
}
