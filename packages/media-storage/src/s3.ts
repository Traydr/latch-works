import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
