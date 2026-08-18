import {
  createS3StorageClient,
  createSignedPutUrl,
  type SignedPutUrlResult,
} from "@latch-works/media-storage";

import { env } from "../../env/server";
import { requireSyncApiToken } from "../auth/api-token";
import { assertNoActiveCleanupJob } from "../management/guards";
import {
  type CompleteObjectInput,
  completeSyncedObject,
  type FinalizeSyncRunInput,
  finalizeSyncRun,
  markRemoteDeleted,
  type StartSyncRunInput,
  startSyncRun,
} from "./store";

/**
 * Everything the four sync route handlers reach for: the bearer token check,
 * the cleanup guard that closes the API during a wipe, the store writes, and
 * the signed upload URL. Handlers take this so a suite can drive request
 * parsing, status codes, and routing without an archive or a bucket.
 */
export interface SyncRouteDependencies {
  assertNoActiveCleanupJob(): Promise<void>;
  completeSyncedObject(request: { input: CompleteObjectInput }): Promise<{ status: "database" }>;
  createSignedUploadUrl(request: {
    contentLength: number;
    contentType: string;
    key: string;
    sha256: string;
  }): Promise<SignedPutUrlResult>;
  finalizeSyncRun(request: { input: FinalizeSyncRunInput }): Promise<{ status: "database" }>;
  markRemoteDeleted(request: {
    logicalPath: string;
    syncRunId: string;
  }): Promise<{ status: "database" }>;
  requireSyncApiToken(request: Request): Response | null;
  startSyncRun(request: {
    input: StartSyncRunInput;
  }): Promise<{ status: "database"; syncRunId: string }>;
}

export const syncRouteDependencies: SyncRouteDependencies = {
  assertNoActiveCleanupJob: () => assertNoActiveCleanupJob(),
  completeSyncedObject,
  createSignedUploadUrl: (request) =>
    createSignedPutUrl({
      ...request,
      storage: createS3StorageClient({
        accessKeyId: env.S3_ACCESS_KEY_ID,
        bucket: env.S3_BUCKET,
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      }),
    }),
  finalizeSyncRun,
  markRemoteDeleted,
  requireSyncApiToken,
  startSyncRun,
};
