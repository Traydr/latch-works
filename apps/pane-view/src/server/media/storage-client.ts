import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SHA256_PATTERN } from "@latch-works/sync-protocol";
import { env } from "../../env/server";

/** A bucket plus the command-sending surface of an S3 client. */
export interface S3CommandStorage {
  bucket: string;
  client: Pick<S3Client, "send">;
}

/** A bucket plus a full S3 client; request presigning needs more than `send`. */
export interface S3StorageClient extends S3CommandStorage {
  client: S3Client;
}

function createPaneViewStorageClient(): S3StorageClient {
  return {
    bucket: env.S3_BUCKET,
    client: new S3Client({
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: true,
      region: env.S3_REGION,
      // Avoid checksum query params on presigned PUT URLs. Lockstep (and browsers)
      // upload with Content-Type only; automatic CRC32 signing breaks those clients.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
  };
}

let sharedStorageClient: S3StorageClient | undefined;

/**
 * The one client request handlers and maintenance jobs share, created on
 * first use; an S3 client pools its connections.
 */
export function getPaneViewStorageClient(): S3StorageClient {
  sharedStorageClient ??= createPaneViewStorageClient();

  return sharedStorageClient;
}

export async function createSignedGetUrl({
  expiresInSeconds,
  key,
  storage = getPaneViewStorageClient(),
}: {
  expiresInSeconds: number;
  key: string;
  storage?: S3StorageClient;
}): Promise<string> {
  return getSignedUrl(storage.client, new GetObjectCommand({ Bucket: storage.bucket, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}

export interface StoredObjectHead {
  checksumSHA256: string | undefined;
  contentLength: number;
  contentType: string | undefined;
  metadata: Record<string, string> | undefined;
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
        // Without it S3 leaves out the stored checksum, so ChecksumSHA256 is never set.
        ChecksumMode: "ENABLED",
        Key: key,
      }),
    );

    return {
      checksumSHA256: response.ChecksumSHA256,
      contentLength: Number(response.ContentLength ?? 0),
      contentType: response.ContentType,
      metadata: response.Metadata,
    };
  } catch (error) {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) {
      return null;
    }

    throw error;
  }
}

export interface ListStoredObjectsPage {
  keys: string[];
  nextContinuationToken: string | undefined;
}

export async function listStoredObjectsByPrefix({
  continuationToken,
  limit,
  prefix,
  storage = getPaneViewStorageClient(),
}: {
  continuationToken?: string;
  limit: number;
  prefix: string;
  storage?: S3CommandStorage;
}): Promise<ListStoredObjectsPage> {
  const response = await storage.client.send(
    new ListObjectsV2Command({
      Bucket: storage.bucket,
      ContinuationToken: continuationToken,
      MaxKeys: limit,
      Prefix: prefix,
    }),
  );

  return {
    keys: response.Contents?.flatMap((entry) => (entry.Key ? [entry.Key] : [])) ?? [],
    nextContinuationToken: response.IsTruncated ? response.NextContinuationToken : undefined,
  };
}

/**
 * Deletes `keys`, at most `maxConcurrent` at a time, and throws once all have
 * been tried if any failed, naming the first failure.
 */
export async function deleteStoredObjects({
  keys,
  maxConcurrent,
  storage = getPaneViewStorageClient(),
}: {
  keys: string[];
  maxConcurrent: number;
  storage?: S3CommandStorage;
}): Promise<void> {
  const queue = [...keys];
  let errors = 0;
  let firstError: Error | undefined;

  const worker = async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each worker deletes one key at a time; `maxConcurrent` workers run in parallel.
        await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
      } catch (error) {
        errors += 1;
        firstError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxConcurrent, queue.length) }, worker));

  if (errors > 0) {
    const reason = firstError?.message ?? "Unknown object storage error";

    throw new Error(`${errors} object storage deletes failed: ${reason}`);
  }
}

export interface SignedPutUrlResult {
  headers: Record<string, string>;
  uploadUrl: string;
}

/** The user-metadata key a signed upload stores its lowercase hex SHA-256 under. */
export const SHA256_METADATA_KEY = "sha256";
const SHA256_METADATA_HEADER = `x-amz-meta-${SHA256_METADATA_KEY}`;

/** S3's `x-amz-checksum-sha256` value: the base64 of the raw digest a hex SHA-256 names. */
export function sha256ChecksumHeader(sha256: string): string {
  return Buffer.from(sha256, "hex").toString("base64");
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
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Invalid sha256 value: ${sha256}`);
  }

  const normalizedSha256 = sha256.toLowerCase();
  const checksumSHA256 = sha256ChecksumHeader(normalizedSha256);

  const candidateHeaders = {
    "Content-Length": String(contentLength),
    "Content-Type": contentType,
    "x-amz-checksum-sha256": checksumSHA256,
    [SHA256_METADATA_HEADER]: normalizedSha256,
  } satisfies Record<string, string>;

  const uploadUrl = await getSignedUrl(
    storage.client,
    new PutObjectCommand({
      Bucket: storage.bucket,
      ChecksumSHA256: checksumSHA256,
      ContentLength: contentLength,
      ContentType: contentType,
      Key: key,
      Metadata: { [SHA256_METADATA_KEY]: normalizedSha256 },
    }),
    {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(["content-length", "content-type"]),
      unhoistableHeaders: new Set(["x-amz-checksum-sha256", SHA256_METADATA_HEADER]),
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
    SHA256_METADATA_HEADER,
  ]) {
    if (!signedHeaderNames.has(required)) {
      throw new Error(`Presigned PUT URL omitted required signed header: ${required}`);
    }
  }

  return { headers, uploadUrl };
}
