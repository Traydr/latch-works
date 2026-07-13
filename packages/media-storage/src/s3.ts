import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
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

export interface S3StorageClient {
  bucket: string;
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
  contentLength: number;
  contentType: string | undefined;
  etag: string | undefined;
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
  storage: S3StorageClient;
}): Promise<StoredObjectHead | null> {
  try {
    const response = await storage.client.send(
      new HeadObjectCommand({
        Bucket: storage.bucket,
        Key: key,
      }),
    );

    return {
      contentLength: Number(response.ContentLength ?? 0),
      contentType: response.ContentType,
      etag: response.ETag,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
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
  storage: S3StorageClient;
}): Promise<StoredObjectBody | null> {
  try {
    const response = await storage.client.send(
      new GetObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        ...(range ? { Range: range } : {}),
      }),
    );

    if (!response.Body) {
      return null;
    }

    return {
      body: response.Body as Readable,
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
      contentType: response.ContentType,
      etag: response.ETag,
      statusCode: response.$metadata.httpStatusCode ?? (range ? 206 : 200),
    };
  } catch (error) {
    if (isNotFoundError(error)) {
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
  storage: S3StorageClient;
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
  storage: S3StorageClient;
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
  storage: S3StorageClient;
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
  onError?: (error: unknown, key: string) => void;
  storage: S3StorageClient;
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
          onError?.(error, key);
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
  storage: S3StorageClient;
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
  storage: S3StorageClient;
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

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "NotFound" || error.name === "NoSuchKey")
  );
}

export async function createSignedPutUrl({
  contentType,
  expiresInSeconds = 300,
  key,
  storage,
}: {
  contentType: string;
  expiresInSeconds?: number;
  key: string;
  storage: S3StorageClient;
}): Promise<string> {
  return getSignedUrl(
    storage.client,
    new PutObjectCommand({
      Bucket: storage.bucket,
      ContentType: contentType,
      Key: key,
    }),
    { expiresIn: expiresInSeconds },
  );
}
