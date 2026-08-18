import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { MediaItem } from "@latch-works/media-domain";
import { type ArchiveFileFingerprint, fingerprintsMatch } from "@latch-works/media-index";
import { z } from "zod";
import { toError } from "./format.js";

const CACHE_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export interface HashCacheEntry extends ArchiveFileFingerprint {
  path: string;
  sha256: string;
}

/** On-disk entry: `mtimeMs` is truncated and `sha256` lower-cased as it is read. */
const HashCacheEntrySchema = z
  .object({
    ctimeMs: z.number().finite().optional(),
    mtimeMs: z.number().finite(),
    path: z.string(),
    sha256: z.string().regex(SHA256_PATTERN),
    size: z.number().int().nonnegative(),
  })
  .transform(
    (entry): HashCacheEntry => ({
      ctimeMs: entry.ctimeMs,
      mtimeMs: Math.trunc(entry.mtimeMs),
      path: entry.path,
      sha256: entry.sha256.toLowerCase(),
      size: entry.size,
    }),
  );

const PersistedHashCacheSchema = z.object({
  entries: z.array(HashCacheEntrySchema),
  sourceRoot: z.string(),
  version: z.literal(CACHE_VERSION),
});

type PersistedHashCache = z.output<typeof PersistedHashCacheSchema>;

/** Node's fs rejections carry an `errno` `code`; anything else fails the parse. */
const FileSystemErrorSchema = z.object({ code: z.string() });

export interface LoadHashCacheOptions {
  cacheRoot?: string;
  sourceRoot: string;
}

export interface HashCacheHydration {
  hits: number;
  items: MediaItem[];
}

export class HashCache {
  private readonly entries: Map<string, HashCacheEntry>;

  constructor(
    readonly filePath: string,
    readonly sourceRoot: string,
    entries: readonly HashCacheEntry[] = [],
  ) {
    this.entries = new Map(entries.map((entry) => [entry.path, entry]));
  }

  get(pathname: string, fingerprint: ArchiveFileFingerprint): string | undefined {
    const entry = this.entries.get(pathname);
    return entry && fingerprintsMatch(entry, fingerprint) ? entry.sha256 : undefined;
  }

  set(pathname: string, fingerprint: ArchiveFileFingerprint, sha256: string): void {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error(`Invalid SHA-256 for hash cache entry: ${pathname}`);
    }
    this.entries.set(pathname, {
      ctimeMs: fingerprint.ctimeMs,
      mtimeMs: Math.trunc(fingerprint.mtimeMs),
      path: pathname,
      sha256: sha256.toLowerCase(),
      size: fingerprint.size,
    });
  }

  hydrate(
    items: readonly MediaItem[],
    fingerprints: ReadonlyMap<string, ArchiveFileFingerprint>,
  ): HashCacheHydration {
    let hits = 0;
    const hydratedItems = items.map((item) => {
      const fingerprint = fingerprints.get(item.path);
      const sha256 = fingerprint ? this.get(item.path, fingerprint) : undefined;
      if (!sha256) {
        return item;
      }
      hits += 1;
      return { ...item, id: sha256, sha256 };
    });
    return { hits, items: hydratedItems };
  }

  updateFromItems(
    items: readonly MediaItem[],
    fingerprints: ReadonlyMap<string, ArchiveFileFingerprint>,
  ): void {
    for (const item of items) {
      const fingerprint = fingerprints.get(item.path);
      if (fingerprint && item.sha256) {
        this.set(item.path, fingerprint, item.sha256);
      }
    }
  }

  retain(paths: ReadonlySet<string>): void {
    for (const pathname of this.entries.keys()) {
      if (!paths.has(pathname)) {
        this.entries.delete(pathname);
      }
    }
  }

  async save(): Promise<void> {
    const persisted: PersistedHashCache = {
      entries: [...this.entries.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      sourceRoot: this.sourceRoot,
      version: CACHE_VERSION,
    };
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function defaultHashCacheRoot(): string {
  return path.join(homedir(), ".latch-works", "hash-cache", `v${CACHE_VERSION}`);
}

export function hashCachePath(sourceRoot: string, cacheRoot = defaultHashCacheRoot()): string {
  const canonicalRoot = canonicalSourceRoot(sourceRoot);
  const sourceKey = createHash("sha256").update(canonicalRoot).digest("hex");
  return path.join(cacheRoot, `${sourceKey}.json`);
}

export async function loadHashCache({
  cacheRoot,
  sourceRoot,
}: LoadHashCacheOptions): Promise<{ cache: HashCache; warning?: string }> {
  const canonicalRoot = canonicalSourceRoot(sourceRoot);
  const filePath = hashCachePath(canonicalRoot, cacheRoot);

  try {
    const raw = await readFile(filePath, "utf-8");
    const persisted = PersistedHashCacheSchema.parse(JSON.parse(raw));
    if (canonicalSourceRoot(persisted.sourceRoot) !== canonicalRoot) {
      throw new Error("cache source root does not match");
    }
    return { cache: new HashCache(filePath, canonicalRoot, persisted.entries) };
  } catch (error) {
    const failure = toError(error);
    if (isMissingFileError(failure)) {
      return { cache: new HashCache(filePath, canonicalRoot) };
    }
    return {
      cache: new HashCache(filePath, canonicalRoot),
      warning: `Hash cache could not be read and will be rebuilt: ${failure.message}`,
    };
  }
}

function canonicalSourceRoot(sourceRoot: string): string {
  const resolved = path.normalize(path.resolve(sourceRoot));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isMissingFileError(error: Error): boolean {
  const parsed = FileSystemErrorSchema.safeParse(error);
  return parsed.success && parsed.data.code === "ENOENT";
}
