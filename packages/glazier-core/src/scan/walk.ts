import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { isSystemJunkDirectory, isSystemJunkFile } from "@latch-works/media-domain";

import { abortError } from "../media/run-tool.js";

/** A regular file the walk found, with the fingerprint that tells later scans it changed. */
export interface WalkedFile {
  /** Path inside the root with forward slashes. */
  relPath: string;
  dir: string;
  name: string;
  /** Lowercased, without the dot; "" when the name has none. */
  ext: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Device and inode as decimal strings: hard links to one file share both. */
  dev: string;
  ino: string;
  /** `Thumbs.db`, `._*` and the like: recorded so they can be cleaned up. */
  junk: boolean;
}

export interface WalkSummary {
  files: number;
  /** Folders holding no files and no folders, relative to the root. */
  emptyFolders: string[];
  /** Symlinks and other non-regular entries, which Glazier never follows or touches. */
  skippedEntries: number;
}

export interface WalkOptions {
  rootPath: string;
  /** Called with batches of files as the walk finds them. */
  onBatch: (files: WalkedFile[]) => void;
  onProgress?: (files: number, currentDir: string) => void;
  signal?: AbortSignal;
}

const BATCH_SIZE = 500;

const STAT_CONCURRENCY = 32;

/**
 * Whole milliseconds of a nanosecond timestamp, computed exactly. Converting the nanoseconds to a
 * float first can round across a millisecond boundary, and then two reads of one untouched file
 * would disagree about whether it changed.
 */
export function wholeMs(nanoseconds: bigint): number {
  return Number(nanoseconds / 1_000_000n);
}

/**
 * Finder's view settings for a folder. Finder writes one into every folder it shows, so cleaning
 * them up never sticks: the walk leaves them out, and one leaves only with its empty folder.
 */
export function isFinderViewSettings(name: string): boolean {
  return name.toLowerCase() === ".ds_store";
}

export function extensionOf(name: string): string {
  const dotIndex = name.lastIndexOf(".");

  return dotIndex > 0 && dotIndex < name.length - 1 ? name.slice(dotIndex + 1).toLowerCase() : "";
}

/**
 * Walks a root breadth-first. It stays inside the root: symlinks are never followed and
 * non-regular files are skipped, as everywhere else in Latch Works. System junk folders (which
 * include Glazier's holding folder) are not entered, and Finder's `.DS_Store` files are left out.
 */
export async function walkRoot(options: WalkOptions): Promise<WalkSummary> {
  const queue: string[] = [""];
  const emptyFolders: string[] = [];
  let batch: WalkedFile[] = [];
  let files = 0;
  let skippedEntries = 0;

  const flush = () => {
    if (batch.length > 0) {
      options.onBatch(batch);
      batch = [];
    }
  };

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (options.signal?.aborted) {
      throw abortError();
    }

    const relDir = queue[cursor] ?? "";
    const absDir = path.join(options.rootPath, ...relDir.split("/").filter(Boolean));
    let entries: Dirent[];

    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      // A folder that vanished or cannot be read is skipped; the rest of the root still scans.
      continue;
    }

    let contentCount = 0;
    const fileEntries: Dirent[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isSystemJunkDirectory(entry.name)) {
          queue.push(relDir ? `${relDir}/${entry.name}` : entry.name);
          contentCount += 1;
        }
      } else if (entry.isFile()) {
        if (isFinderViewSettings(entry.name)) {
          continue;
        }

        fileEntries.push(entry);

        if (!isSystemJunkFile(entry.name)) {
          contentCount += 1;
        }
      } else {
        skippedEntries += 1;
      }
    }

    if (contentCount === 0 && relDir !== "") {
      emptyFolders.push(relDir);
    }

    for (let start = 0; start < fileEntries.length; start += STAT_CONCURRENCY) {
      const slice = fileEntries.slice(start, start + STAT_CONCURRENCY);

      const stats = await Promise.all(
        slice.map((entry) =>
          lstat(path.join(absDir, entry.name), { bigint: true }).catch(() => null),
        ),
      );

      slice.forEach((entry, index) => {
        const stat = stats[index];

        if (!stat?.isFile()) {
          skippedEntries += 1;

          return;
        }

        batch.push({
          relPath: relDir ? `${relDir}/${entry.name}` : entry.name,
          dir: relDir,
          name: entry.name,
          ext: extensionOf(entry.name),
          size: Number(stat.size),
          mtimeMs: wholeMs(stat.mtimeNs),
          ctimeMs: wholeMs(stat.ctimeNs),
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
          junk: isSystemJunkFile(entry.name),
        });
        files += 1;
      });

      if (batch.length >= BATCH_SIZE) {
        flush();
      }
    }

    options.onProgress?.(files, relDir);
  }

  flush();

  return { files, emptyFolders, skippedEntries };
}
