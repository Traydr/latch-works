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
  stat: (filePath: string) => Promise<{ mtimeMs: number; size: number }>;
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
  items: MediaItem[];
  skipped: number;
  skippedEntries: SkippedArchiveEntry[];
  sourceRoot: string;
}

export interface SkippedArchiveEntry {
  path: string;
  reason: "system-file" | "unsupported-extension" | "not-a-regular-file";
}

async function hashFile({
  filePath,
  onProgress,
  operations,
  signal,
}: {
  filePath: string;
  onProgress?: (bytesHashed: number) => void;
  operations: ScanArchiveOperations;
  signal?: AbortSignal;
}): Promise<string> {
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
  return hash.digest("hex");
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
  work: (task: T, add: (task: T) => void) => Promise<void>;
}): Promise<void> {
  let next = 0;
  let active = 0;

  await new Promise<void>((resolve, reject) => {
    const schedule = (): void => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
        return;
      }

      while (active < workerCount && next < tasks.length) {
        const task = tasks[next++];
        if (task === undefined) {
          continue;
        }
        active += 1;
        void work(task, (newTask) => {
          throwIfAborted(signal);
          tasks.push(newTask);
        }).then(
          () => {
            active -= 1;
            if (next === tasks.length && active === 0) {
              resolve();
            } else {
              schedule();
            }
          },
          (error: unknown) => reject(error),
        );
      }

      if (next === tasks.length && active === 0) {
        resolve();
      }
    };

    schedule();
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
  const items: MediaItem[] = [];
  const skippedEntries: SkippedArchiveEntry[] = [];
  const candidates: Array<{ absolutePath: string; name: string; path: string }> = [];
  const directories = [root];

  await runQueue({
    concurrency: concurrency(directoryConcurrency),
    signal,
    tasks: directories,
    work: async (currentPath, addDirectory) => {
      throwIfAborted(signal);
      const entries = await operations.readdir(currentPath);
      throwIfAborted(signal);
      for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
        throwIfAborted(signal);
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
    work: async (candidate) => {
      throwIfAborted(signal);
      const fileStat = await operations.stat(candidate.absolutePath);
      throwIfAborted(signal);
      const sha256 = hashFiles
        ? await hashFile({
            filePath: candidate.absolutePath,
            onProgress: (bytesHashed) =>
              onProgress?.({
                bytesHashed,
                fileSize: fileStat.size,
                filesFound: indexedItems.size,
                path: candidate.path,
                skipped: skippedEntries.length,
                stage: "hashing",
              }),
            operations,
            signal,
          })
        : undefined;

      indexedItems.set(candidate.path, {
        id: sha256 ?? candidate.path,
        path: candidate.path,
        parentPath: getParentPath(candidate.path),
        name: candidate.name,
        extension: getExtension(candidate.name),
        mediaType: detectMediaType(candidate.name),
        size: fileStat.size,
        mtimeMs: Math.trunc(fileStat.mtimeMs),
        sha256,
      });
      onProgress?.({
        filesFound: indexedItems.size,
        path: candidate.path,
        skipped: skippedEntries.length,
        stage: "scanning",
      });
    }
  });

  for (const candidate of candidates) {
    const item = indexedItems.get(candidate.path);
    if (item) {
      items.push(item);
    }
  }

  return {
    items,
    skipped: skippedEntries.length,
    skippedEntries,
    sourceRoot: root,
  };
}
