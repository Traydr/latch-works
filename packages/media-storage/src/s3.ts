import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandInput,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface S3StorageConfig {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  region: string;
  secretAccessKey: string;
}

/** A bucket plus the command-sending surface of an S3 client. */
export interface S3CommandStorage {
  bucket: string;
  client: Pick<S3Client, "send">;
}

/** A bucket plus a full S3 client; request presigning needs more than `send`. */
export interface S3StorageClient extends S3CommandStorage {
  client: S3Client;
}

export function readS3StorageConfig(env: NodeJS.ProcessEnv): S3StorageConfig | null {
  const endpoint = env.S3_ENDPOINT;
  const region = env.S3_REGION;
  const bucket = env.S3_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;

  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    accessKeyId,
    bucket,
    endpoint,
    region,
    secretAccessKey,
  };
}

export function createS3StorageClient(config: S3StorageConfig): S3StorageClient {
  return {
    bucket: config.bucket,
    client: new S3Client({
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      endpoint: config.endpoint,
      forcePathStyle: true,
      region: config.region,
      // Avoid checksum query params on presigned PUT URLs. Lockstep (and browsers)
      // upload with Content-Type only; automatic CRC32 signing breaks those clients.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
  };
}

export async function createSignedGetUrl({
  expiresInSeconds = 60,
  key,
  storage,
}: {
  expiresInSeconds?: number;
  key: string;
  storage: S3StorageClient;
}): Promise<string> {
  return getSignedUrl(
    storage.client,
    new GetObjectCommand({
      Bucket: storage.bucket,
      Key: key,
    }),
    { expiresIn: expiresInSeconds },
  );
}

export interface StoredObjectHead {
  checksumSHA256: string | undefined;
  contentLength: number;
  contentType: string | undefined;
  etag: string | undefined;
  metadata: Record<string, string> | undefined;
}

export interface StoredObjectBody {
  body: Readable;
  contentLength: number | undefined;
  contentRange: string | undefined;
  contentType: string | undefined;
  etag: string | undefined;
  statusCode: number;
}

export async function headStoredObject({
  key,
  storage,
}: {
  key: string;
  storage: S3CommandStorage;
}): Promise<StoredObjectHead | null> {
  try {
    const response = await storage.client.send(
      new HeadObjectCommand({
        Bucket: storage.bucket,
        Key: key,
      }),
    );

    return {
      checksumSHA256: response.ChecksumSHA256,
      contentLength: Number(response.ContentLength ?? 0),
      contentType: response.ContentType,
      etag: response.ETag,
      metadata: response.Metadata,
    };
  } catch (error) {
    if (isNotFoundError(toError(error))) {
      return null;
    }

    throw error;
  }
}

export async function getStoredObject({
  key,
  range,
  storage,
}: {
  key: string;
  range?: string;
  storage: S3CommandStorage;
}): Promise<StoredObjectBody | null> {
  const input: GetObjectCommandInput = {
    Bucket: storage.bucket,
    Key: key,
  };
  if (range) {
    input.Range = range;
  }

  try {
    const response = await storage.client.send(new GetObjectCommand(input));

    if (!response.Body) {
      return null;
    }
    if (!(response.Body instanceof Readable)) {
      throw new TypeError(`S3 returned a non-Node stream body for key: ${key}`);
    }

    return {
      body: response.Body,
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
      contentType: response.ContentType,
      etag: response.ETag,
      statusCode: response.$metadata.httpStatusCode ?? (range ? 206 : 200),
    };
  } catch (error) {
    if (isNotFoundError(toError(error))) {
      return null;
    }

    throw error;
  }
}

export async function deleteStoredObject({
  key,
  storage,
}: {
  key: string;
  storage: S3CommandStorage;
}): Promise<void> {
  await storage.client.send(
    new DeleteObjectCommand({
      Bucket: storage.bucket,
      Key: key,
    }),
  );
}

export interface ListStoredObjectsPage {
  keys: string[];
  nextContinuationToken: string | undefined;
}

export interface StoredObjectSummary {
  key: string;
  size: number;
}

export interface ListStoredObjectSummariesPage {
  nextContinuationToken: string | undefined;
  objects: StoredObjectSummary[];
}

export async function listStoredObjectSummariesByPrefix({
  continuationToken,
  limit = 1000,
  prefix,
  storage,
}: {
  continuationToken?: string;
  limit?: number;
  prefix: string;
  storage: S3CommandStorage;
}): Promise<ListStoredObjectSummariesPage> {
  const response = await storage.client.send(
    new ListObjectsV2Command({
      Bucket: storage.bucket,
      ContinuationToken: continuationToken,
      MaxKeys: limit,
      Prefix: prefix,
    }),
  );

  const objects =
    response.Contents?.flatMap((entry) =>
      entry.Key ? [{ key: entry.Key, size: Number(entry.Size ?? 0) }] : [],
    ) ?? [];

  return {
    objects,
    nextContinuationToken: response.IsTruncated ? response.NextContinuationToken : undefined,
  };
}

export async function listStoredObjectsByPrefix({
  continuationToken,
  limit = 1000,
  prefix,
  storage,
}: {
  continuationToken?: string;
  limit?: number;
  prefix: string;
  storage: S3CommandStorage;
}): Promise<ListStoredObjectsPage> {
  const page = await listStoredObjectSummariesByPrefix({
    continuationToken,
    limit,
    prefix,
    storage,
  });

  return {
    keys: page.objects.map((object) => object.key),
    nextContinuationToken: page.nextContinuationToken,
  };
}

export async function deleteStoredObjectsBatch({
  keys,
  maxConcurrent = keys.length || 1,
  onError,
  storage,
}: {
  keys: string[];
  maxConcurrent?: number;
  onError?: (error: Error, key: string) => void;
  storage: S3CommandStorage;
}): Promise<{ deleted: number; errors: number }> {
  let deleted = 0;
  let errors = 0;

  const queue = [...keys];
  const workerCount = Math.min(Math.max(1, maxConcurrent), queue.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const key = queue.shift();
        if (!key) continue;
        try {
          await deleteStoredObject({ key, storage });
          deleted += 1;
        } catch (error) {
          errors += 1;
          onError?.(toError(error), key);
        }
      }
    }),
  );

  return { deleted, errors };
}

export async function putStoredObject({
  body,
  contentType,
  key,
  storage,
}: {
  body: Buffer | Uint8Array;
  contentType: string;
  key: string;
  storage: S3CommandStorage;
}): Promise<void> {
  await storage.client.send(
    new PutObjectCommand({
      Body: body,
      Bucket: storage.bucket,
      ContentType: contentType,
      Key: key,
    }),
  );
}

export async function readStoredObjectBytes({
  key,
  storage,
}: {
  key: string;
  storage: S3CommandStorage;
}): Promise<Buffer | null> {
  const object = await getStoredObject({ key, storage });
  if (!object) {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of object.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function isNotFoundError(error: Error): boolean {
  return error.name === "NotFound" || error.name === "NoSuchKey";
}

/** Narrow a caught value to an Error at the catch site so callees take a real domain type. */
function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

export interface SignedPutUrlResult {
  headers: Record<string, string>;
  uploadUrl: string;
}

export async function createSignedPutUrl({
  contentLength,
  contentType,
  expiresInSeconds = 300,
  key,
  sha256,
  storage,
}: {
  contentLength: number;
  contentType: string;
  expiresInSeconds?: number;
  key: string;
  sha256: string;
  storage: S3StorageClient;
}): Promise<SignedPutUrlResult> {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error(`Invalid sha256 value: ${sha256}`);
  }

  const normalizedSha256 = sha256.toLowerCase();
  const checksumSHA256 = Buffer.from(normalizedSha256, "hex").toString("base64");
  const candidateHeaders = {
    "Content-Length": String(contentLength),
    "Content-Type": contentType,
    "x-amz-checksum-sha256": checksumSHA256,
    "x-amz-meta-sha256": normalizedSha256,
  } satisfies Record<string, string>;

  const uploadUrl = await getSignedUrl(
    storage.client,
    new PutObjectCommand({
      Bucket: storage.bucket,
      ChecksumSHA256: checksumSHA256,
      ContentLength: contentLength,
      ContentType: contentType,
      Key: key,
      Metadata: {
        sha256: normalizedSha256,
      },
    }),
    {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(["content-length", "content-type"]),
      unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-meta-sha256"]),
    },
  );

  const signedHeaderNames = new Set(
    (new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";").filter(Boolean),
  );
  const headers: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(candidateHeaders)) {
    if (signedHeaderNames.has(headerName.toLowerCase())) {
      headers[headerName] = headerValue;
    }
  }

  for (const required of [
    "content-type",
    "content-length",
    "x-amz-checksum-sha256",
    "x-amz-meta-sha256",
  ]) {
    if (!signedHeaderNames.has(required)) {
      throw new Error(`Presigned PUT URL omitted required signed header: ${required}`);
    }
  }

  return { headers, uploadUrl };
}
