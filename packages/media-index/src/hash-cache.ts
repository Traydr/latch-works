import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface HashCacheEntry {
  mtimeMs: number;
  sha256: string;
  size: number;
}

export interface HashCacheData {
  entries: Record<string, HashCacheEntry>;
  version: 1;
}

export function createEmptyHashCache(): HashCacheData {
  return { version: 1, entries: {} };
}

export function lookupHashCache(
  cache: HashCacheData,
  filePath: string,
  mtimeMs: number,
  size: number,
): string | undefined {
  const entry = cache.entries[filePath];
  if (!entry) {
    return undefined;
  }
  if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
    return undefined;
  }
  return entry.sha256;
}

export function updateHashCache(
  cache: HashCacheData,
  filePath: string,
  mtimeMs: number,
  size: number,
  sha256: string,
): void {
  cache.entries[filePath] = { mtimeMs, sha256, size };
}

export async function readHashCache(cachePath: string): Promise<HashCacheData> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as HashCacheData;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") {
      return createEmptyHashCache();
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyHashCache();
    }
    throw error;
  }
}

export async function writeHashCache(cachePath: string, cache: HashCacheData): Promise<void> {
  await writeFile(cachePath, `${JSON.stringify(cache)}\n`, "utf8");
}

export function defaultHashCachePath(sourceRoot: string): string {
  return path.join(path.resolve(sourceRoot), ".latch-works", "hash-cache.json");
}
