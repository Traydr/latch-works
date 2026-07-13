import {
  deleteStoredObjectsBatch,
  listStoredObjectSummariesByPrefix,
  type StoredObjectSummary,
} from "@latch-works/media-storage";
import { createPaneViewStorageClient } from "../media/storage-client";

export const legacyDerivativePrefixes = ["thumbnails/", "previews/"] as const;
export type LegacyDerivativePrefix = (typeof legacyDerivativePrefixes)[number];

export interface LegacyDerivativePrefixInventory {
  bytes: number;
  count: number;
  prefix: LegacyDerivativePrefix;
}

export interface LegacyDerivativeInventory {
  prefixes: LegacyDerivativePrefixInventory[];
  totalBytes: number;
  totalCount: number;
}

export async function readLegacyDerivativeInventory(): Promise<LegacyDerivativeInventory> {
  const storage = createPaneViewStorageClient();
  const prefixes: LegacyDerivativePrefixInventory[] = [];

  for (const prefix of legacyDerivativePrefixes) {
    let continuationToken: string | undefined;
    let bytes = 0;
    let count = 0;
    do {
      const page = await listStoredObjectSummariesByPrefix({
        continuationToken,
        prefix,
        storage,
      });
      bytes += page.objects.reduce((sum, object) => sum + object.size, 0);
      count += page.objects.length;
      continuationToken = page.nextContinuationToken;
    } while (continuationToken);
    prefixes.push({ bytes, count, prefix });
  }

  return {
    prefixes,
    totalBytes: prefixes.reduce((sum, item) => sum + item.bytes, 0),
    totalCount: prefixes.reduce((sum, item) => sum + item.count, 0),
  };
}

export async function readLegacyDerivativeBatch(
  prefix: LegacyDerivativePrefix,
): Promise<StoredObjectSummary[]> {
  const page = await listStoredObjectSummariesByPrefix({
    limit: 100,
    prefix,
    storage: createPaneViewStorageClient(),
  });
  return page.objects;
}

export async function deleteLegacyDerivativeBatch(objects: StoredObjectSummary[]): Promise<{
  deletedBytes: number;
  deletedCount: number;
  errorCount: number;
}> {
  const failedKeys = new Set<string>();
  const result = await deleteStoredObjectsBatch({
    keys: objects.map((object) => object.key),
    maxConcurrent: 10,
    onError: (_error, key) => failedKeys.add(key),
    storage: createPaneViewStorageClient(),
  });

  return {
    deletedBytes: objects.reduce(
      (sum, object) => sum + (failedKeys.has(object.key) ? 0 : object.size),
      0,
    ),
    deletedCount: result.deleted,
    errorCount: result.errors,
  };
}
