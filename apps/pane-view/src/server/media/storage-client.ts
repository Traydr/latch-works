import { createS3StorageClient, type S3StorageClient } from "@latch-works/media-storage";
import { env } from "../../env/server";

function createPaneViewStorageClient(): S3StorageClient {
  return createS3StorageClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
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
