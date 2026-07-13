import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { MediaItem } from "@latch-works/media-domain";
import {
  defaultHashCachePath,
  lookupHashCache,
  readHashCache,
  updateHashCache,
  writeHashCache,
  type HashCacheData,
} from "./hash-cache.js";
import {
  scanArchive,
  type ScanArchiveOptions,
  type ScanArchiveOperations,
  type ScanArchiveResult,
} from "./scan.js";
import type { RemoteEntrySnapshot } from "./sync-plan.js";

export interface ScanWithHashCacheOptions extends ScanArchiveOptions {
  cache?: HashCacheData;
  cachePath?: string;
  persistCache?: boolean;
}

export interface ScanSelectiveHashOptions extends ScanArchiveOptions {
  remoteEntries: readonly RemoteEntrySnapshot[];
}

function needsLocalHash(localSize: number, remote: RemoteEntrySnapshot | undefined): boolean {
  if (!remote) {
    return true;
  }
  if (remote.size !== localSize) {
    return true;
  }
  return false;
}

const defaultOperations: ScanArchiveOperations = {
  createReadStream,
  readdir: (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
  stat,
};

function resolveConcurrency(value: number | undefined): number {
  return value ?? 4;
}

async function hashPathsSubset({
  fileConcurrency,
  items,
  operations = defaultOperations,
  signal,
  sourceRoot,
}: {
  fileConcurrency?: number;
  items: MediaItem[];
  onProgress?: ScanArchiveOptions["onProgress"];
  operations?: ScanArchiveOperations;
  signal?: AbortSignal;
  sourceRoot: string;
}): Promise<Map<string, string>> {
  const root = path.resolve(sourceRoot);
  const workerCount = resolveConcurrency(fileConcurrency);
  const hashes = new Map<string, string>();
  let next = 0;
  let active = 0;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const schedule = (): void => {
      if (settled) {
        return;
      }
      while (active < workerCount && next < items.length) {
        const item = items[next++];
        if (!item) {
          continue;
        }
        active += 1;
        const absolutePath = path.join(root, item.path);
        void hashSingleFile(absolutePath, operations, signal)
          .then((sha256) => {
            hashes.set(item.path, sha256);
            active -= 1;
            if (next === items.length && active === 0) {
              settled = true;
              resolve();
            } else {
              schedule();
            }
          })
          .catch((error: unknown) => {
            settled = true;
            reject(error);
          });
      }
      if (next === items.length && active === 0) {
        settled = true;
        resolve();
      }
    };
    schedule();
  });

  return hashes;
}

async function hashSingleFile(
  filePath: string,
  operations: ScanArchiveOperations,
  signal?: AbortSignal,
): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = operations.createReadStream(filePath);
    const onAbort = () => stream.destroy(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });

  return hash.digest("hex");
}

/**
 * Re-scan with a local mtime+size keyed hash cache. Unchanged files reuse cached SHA-256.
 */
export async function scanArchiveWithHashCache(
  options: ScanWithHashCacheOptions,
): Promise<ScanArchiveResult & { cache: HashCacheData; cacheHits: number; cacheMisses: number }> {
  const cachePath = options.cachePath ?? defaultHashCachePath(options.sourceRoot);
  const cache = options.cache ?? (await readHashCache(cachePath));
  let cacheHits = 0;
  let cacheMisses = 0;

  const withoutHash = await scanArchive({
    ...options,
    hashFiles: false,
  });

  const toHash: MediaItem[] = [];
  const items: MediaItem[] = [];

  for (const item of withoutHash.items) {
    const cached = lookupHashCache(cache, item.path, item.mtimeMs, item.size);
    if (cached) {
      cacheHits += 1;
      items.push({ ...item, id: cached, sha256: cached });
      continue;
    }
    cacheMisses += 1;
    toHash.push(item);
  }

  const hashedByPath = await hashPathsSubset({
    fileConcurrency: options.fileConcurrency,
    items: toHash,
    onProgress: options.onProgress,
    operations: options.operations,
    signal: options.signal,
    sourceRoot: withoutHash.sourceRoot,
  });

  for (const item of toHash) {
    const sha256 = hashedByPath.get(item.path);
    if (sha256) {
      updateHashCache(cache, item.path, item.mtimeMs, item.size, sha256);
      items.push({ ...item, id: sha256, sha256 });
    } else {
      items.push(item);
    }
  }

  items.sort((left, right) => left.path.localeCompare(right.path));

  if (options.persistCache !== false) {
    await writeHashCache(cachePath, cache);
  }

  return { ...withoutHash, cache, cacheHits, cacheMisses, items };
}

/**
 * Stat every file, but only hash uploads and size mismatches against the remote snapshot.
 */
export async function scanArchiveSelectiveHash(
  options: ScanSelectiveHashOptions,
): Promise<ScanArchiveResult & { hashed: number; skippedHash: number }> {
  const remoteByPath = new Map(options.remoteEntries.map((entry) => [entry.path, entry]));

  const withoutHash = await scanArchive({
    ...options,
    hashFiles: false,
  });

  const toHash = withoutHash.items.filter((item) =>
    needsLocalHash(item.size, remoteByPath.get(item.path)),
  );

  const hashedByPath = await hashPathsSubset({
    fileConcurrency: options.fileConcurrency,
    items: toHash,
    onProgress: options.onProgress,
    operations: options.operations,
    signal: options.signal,
    sourceRoot: withoutHash.sourceRoot,
  });

  const items = withoutHash.items.map((item) => {
    const sha256 = hashedByPath.get(item.path);
    return sha256 ? { ...item, id: sha256, sha256 } : item;
  });

  return {
    ...withoutHash,
    hashed: toHash.length,
    items,
    skippedHash: withoutHash.items.length - toHash.length,
  };
}

/**
 * Fast path: stat all files, reuse cache hits, selective-hash the remainder.
 */
export async function scanArchiveIncremental(
  options: ScanWithHashCacheOptions & { remoteEntries: readonly RemoteEntrySnapshot[] },
): Promise<
  ScanArchiveResult & {
    cache: HashCacheData;
    cacheHits: number;
    cacheMisses: number;
    hashed: number;
    skippedHash: number;
  }
> {
  const remoteByPath = new Map(options.remoteEntries.map((entry) => [entry.path, entry]));
  const cachePath = options.cachePath ?? defaultHashCachePath(options.sourceRoot);
  const cache = options.cache ?? (await readHashCache(cachePath));
  let cacheHits = 0;

  const withoutHash = await scanArchive({
    ...options,
    hashFiles: false,
  });

  const toHash: MediaItem[] = [];
  const items: MediaItem[] = [];

  for (const item of withoutHash.items) {
    const cached = lookupHashCache(cache, item.path, item.mtimeMs, item.size);
    if (cached) {
      cacheHits += 1;
      items.push({ ...item, id: cached, sha256: cached });
      continue;
    }

    if (!needsLocalHash(item.size, remoteByPath.get(item.path))) {
      items.push(item);
      continue;
    }

    toHash.push(item);
  }

  const hashedByPath = await hashPathsSubset({
    fileConcurrency: options.fileConcurrency,
    items: toHash,
    onProgress: options.onProgress,
    operations: options.operations,
    signal: options.signal,
    sourceRoot: withoutHash.sourceRoot,
  });

  for (const item of toHash) {
    const sha256 = hashedByPath.get(item.path);
    if (sha256) {
      updateHashCache(cache, item.path, item.mtimeMs, item.size, sha256);
      items.push({ ...item, id: sha256, sha256 });
    } else {
      items.push(item);
    }
  }

  items.sort((left, right) => left.path.localeCompare(right.path));

  if (options.persistCache !== false) {
    await writeHashCache(cachePath, cache);
  }

  return {
    ...withoutHash,
    cache,
    cacheHits,
    cacheMisses: toHash.length,
    hashed: toHash.length,
    items,
    skippedHash: withoutHash.items.length - toHash.length - cacheHits,
  };
}
