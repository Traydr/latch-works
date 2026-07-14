import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  detectMediaType,
  getExtension,
  getParentPath,
  isSupportedMediaFile,
  isSystemJunkDirectory,
  isSystemJunkFile,
  joinArchivePath,
  type MediaItem,
} from "@latch-works/media-domain";

export interface ScanArchiveOptions {
  directoryConcurrency?: number;
  fileConcurrency?: number;
  hashFiles?: boolean;
  onProgress?: (progress: ScanArchiveProgress) => void;
  operations?: ScanArchiveOperations;
  signal?: AbortSignal;
  sourceRoot: string;
}

export interface ScanArchiveOperations {
  createReadStream: (filePath: string) => Readable;
  readdir: (directoryPath: string) => Promise<DirectoryEntry[]>;
  stat: (filePath: string) => Promise<ArchiveFileFingerprint>;
}

export interface ArchiveFileFingerprint {
  ctimeMs?: number;
  mtimeMs: number;
  size: number;
}

export interface DirectoryEntry {
  isDirectory(): boolean;
  isFile(): boolean;
  name: string;
}

export type ScanArchiveProgress =
  | {
      filesFound: number;
      path?: string;
      skipped: number;
      stage: "scanning";
    }
  | {
      bytesHashed: number;
      fileSize: number;
      filesFound: number;
      path: string;
      skipped: number;
      stage: "hashing";
    };

export interface ScanArchiveResult {
  fingerprints: Map<string, ArchiveFileFingerprint>;
  items: MediaItem[];
  skipped: number;
  skippedEntries: SkippedArchiveEntry[];
  sourceRoot: string;
}

export interface SkippedArchiveEntry {
  path: string;
  reason: "system-file" | "unsupported-extension" | "not-a-regular-file";
}

export async function hashFileContents({
  expected,
  filePath,
  onProgress,
  operations,
  signal,
}: {
  expected?: ArchiveFileFingerprint;
  filePath: string;
  onProgress?: (bytesHashed: number) => void;
  operations: Pick<ScanArchiveOperations, "createReadStream" | "stat">;
  signal?: AbortSignal;
}): Promise<string> {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  let bytesHashed = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = operations.createReadStream(filePath);
    const abort = () => stream.destroy(signal?.reason);
    const cleanup = () => signal?.removeEventListener("abort", abort);

    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk) => {
      if (signal?.aborted) {
        stream.destroy(signal.reason);
        return;
      }
      hash.update(chunk);
      bytesHashed += chunk.length;
      onProgress?.(bytesHashed);
    });
    stream.on("error", (error) => {
      cleanup();
      reject(error);
    });
    stream.on("end", () => {
      cleanup();
      resolve();
    });
  });
  throwIfAborted(signal);

  if (expected) {
    const after = normalizeFingerprint(await operations.stat(filePath));
    throwIfAborted(signal);
    if (!fingerprintsMatch(expected, after)) {
      throw new Error(`File changed while hashing: ${filePath}`);
    }
  }

  return hash.digest("hex");
}

export function fingerprintsMatch(
  left: ArchiveFileFingerprint,
  right: ArchiveFileFingerprint,
): boolean {
  return (
    left.size === right.size &&
    Math.trunc(left.mtimeMs) === Math.trunc(right.mtimeMs) &&
    (left.ctimeMs === undefined ||
      right.ctimeMs === undefined ||
      Math.trunc(left.ctimeMs) === Math.trunc(right.ctimeMs))
  );
}

function normalizeFingerprint(fingerprint: ArchiveFileFingerprint): ArchiveFileFingerprint {
  return {
    ctimeMs: fingerprint.ctimeMs === undefined ? undefined : Math.trunc(fingerprint.ctimeMs),
    mtimeMs: Math.trunc(fingerprint.mtimeMs),
    size: fingerprint.size,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function concurrency(value: number | undefined): number {
  if (value === undefined) {
    return 4;
  }
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new RangeError("Scan concurrency must be an integer between 1 and 16");
  }
  return value;
}

async function runQueue<T>({
  concurrency: workerCount,
  signal,
  tasks,
  work,
}: {
  concurrency: number;
  signal?: AbortSignal;
  tasks: T[];
  work: (task: T, add: (task: T) => void, isRunning: () => boolean) => Promise<void>;
}): Promise<void> {
  let next = 0;
  let active = 0;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const schedule = (): void => {
      if (settled) {
        return;
      }
      try {
        throwIfAborted(signal);
      } catch (error) {
        fail(error);
        return;
      }

      while (active < workerCount && next < tasks.length) {
        const task = tasks[next++];
        if (task === undefined) {
          continue;
        }
        active += 1;
        void work(
          task,
          (newTask) => {
            if (!settled) {
              throwIfAborted(signal);
              tasks.push(newTask);
            }
          },
          () => !settled,
        ).then(
          () => {
            active -= 1;
            if (settled) {
              return;
            }
            if (next === tasks.length && active === 0) {
              settled = true;
              resolve();
            } else {
              schedule();
            }
          },
          (error: unknown) => {
            active -= 1;
            fail(error);
          },
        );
      }

      if (next === tasks.length && active === 0) {
        settled = true;
        resolve();
      }
    };

    schedule();
  });
}

export interface HashArchiveItemsOptions {
  fileConcurrency?: number;
  fingerprints?: ReadonlyMap<string, ArchiveFileFingerprint>;
  items: readonly MediaItem[];
  onProgress?: (progress: ScanArchiveProgress) => void;
  operations?: Pick<ScanArchiveOperations, "createReadStream" | "stat">;
  paths?: ReadonlySet<string>;
  signal?: AbortSignal;
  skipped?: number;
  sourceRoot: string;
}

export async function hashArchiveItems({
  fileConcurrency,
  fingerprints,
  items,
  onProgress,
  operations = { createReadStream, stat },
  paths,
  signal,
  skipped = 0,
  sourceRoot,
}: HashArchiveItemsOptions): Promise<MediaItem[]> {
  const root = path.resolve(sourceRoot);
  const tasks = items.filter(
    (item) => item.sha256 === undefined && (paths === undefined || paths.has(item.path)),
  );
  const hashes = new Map<string, string>();

  await runQueue({
    concurrency: concurrency(fileConcurrency),
    signal,
    tasks,
    work: async (item, _add, isRunning) => {
      throwIfAborted(signal);
      const filePath = path.resolve(root, ...item.path.split("/"));
      const relative = path.relative(root, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Archive path escapes source root: ${item.path}`);
      }

      const expected = fingerprints?.get(item.path) ?? {
        mtimeMs: item.mtimeMs,
        size: item.size,
      };
      const sha256 = await hashFileContents({
        expected,
        filePath,
        onProgress: (bytesHashed) =>
          isRunning() &&
          onProgress?.({
            bytesHashed,
            fileSize: item.size,
            filesFound: items.length,
            path: item.path,
            skipped,
            stage: "hashing",
          }),
        operations,
        signal,
      });
      if (isRunning()) {
        hashes.set(item.path, sha256);
      }
    },
  });

  return items.map((item) => {
    const sha256 = hashes.get(item.path);
    return sha256 ? { ...item, id: sha256, sha256 } : item;
  });
}

export async function scanArchive({
  directoryConcurrency,
  fileConcurrency,
  hashFiles = false,
  onProgress,
  operations = {
    createReadStream,
    readdir: (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
    stat,
  },
  signal,
  sourceRoot,
}: ScanArchiveOptions): Promise<ScanArchiveResult> {
  const root = path.resolve(sourceRoot);
  let items: MediaItem[] = [];
  const fingerprints = new Map<string, ArchiveFileFingerprint>();
  const skippedEntries: SkippedArchiveEntry[] = [];
  const candidates: Array<{ absolutePath: string; name: string; path: string }> = [];
  const directories = [root];

  await runQueue({
    concurrency: concurrency(directoryConcurrency),
    signal,
    tasks: directories,
    work: async (currentPath, addDirectory, isRunning) => {
      throwIfAborted(signal);
      const entries = await operations.readdir(currentPath);
      throwIfAborted(signal);
      if (!isRunning()) {
        return;
      }
      for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
        throwIfAborted(signal);
        if (!isRunning()) {
          return;
        }
        const absolutePath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          if (isSystemJunkDirectory(entry.name)) {
            continue;
          }
          throwIfAborted(signal);
          addDirectory(absolutePath);
          continue;
        }

        if (!entry.isFile()) {
          skippedEntries.push({
            path: joinArchivePath(path.relative(root, absolutePath)),
            reason: "not-a-regular-file",
          });
          continue;
        }

        const relativePath = joinArchivePath(path.relative(root, absolutePath));

        if (isSystemJunkFile(entry.name)) {
          skippedEntries.push({
            path: relativePath,
            reason: "system-file",
          });
          onProgress?.({
            filesFound: items.length,
            skipped: skippedEntries.length,
            stage: "scanning",
          });
          continue;
        }

        if (!isSupportedMediaFile(entry.name)) {
          skippedEntries.push({
            path: relativePath,
            reason: "unsupported-extension",
          });
          onProgress?.({
            filesFound: items.length,
            skipped: skippedEntries.length,
            stage: "scanning",
          });
          continue;
        }

        candidates.push({ absolutePath, name: entry.name, path: relativePath });
      }
    },
  });

  candidates.sort((left, right) => left.path.localeCompare(right.path));
  skippedEntries.sort((left, right) => left.path.localeCompare(right.path));

  const indexedItems = new Map<string, MediaItem>();
  await runQueue({
    concurrency: concurrency(fileConcurrency),
    signal,
    tasks: candidates,
    work: async (candidate, _add, isRunning) => {
      throwIfAborted(signal);
      const fileStat = normalizeFingerprint(await operations.stat(candidate.absolutePath));
      throwIfAborted(signal);
      if (!isRunning()) {
        return;
      }

      fingerprints.set(candidate.path, fileStat);
      indexedItems.set(candidate.path, {
        id: candidate.path,
        path: candidate.path,
        parentPath: getParentPath(candidate.path),
        name: candidate.name,
        extension: getExtension(candidate.name),
        mediaType: detectMediaType(candidate.name),
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      });
      onProgress?.({
        filesFound: indexedItems.size,
        path: candidate.path,
        skipped: skippedEntries.length,
        stage: "scanning",
      });
    },
  });

  for (const candidate of candidates) {
    const item = indexedItems.get(candidate.path);
    if (item) {
      items.push(item);
    }
  }

  if (hashFiles) {
    items = await hashArchiveItems({
      fileConcurrency,
      fingerprints,
      items,
      onProgress,
      operations,
      signal,
      skipped: skippedEntries.length,
      sourceRoot: root,
    });
  }

  return {
    fingerprints,
    items,
    skipped: skippedEntries.length,
    skippedEntries,
    sourceRoot: root,
  };
}
