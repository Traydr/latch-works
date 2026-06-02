import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
