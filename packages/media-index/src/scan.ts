import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  detectMediaType,
  getExtension,
  getParentPath,
  isSystemJunkDirectory,
  isSystemJunkFile,
  joinArchivePath,
  type MediaItem,
} from "@latch-works/media-domain";

export interface ScanArchiveOptions {
  hashFiles?: boolean;
  onProgress?: (progress: ScanArchiveProgress) => void;
  sourceRoot: string;
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
}: {
  filePath: string;
  onProgress?: (bytesHashed: number) => void;
}): Promise<string> {
  const hash = createHash("sha256");
  let bytesHashed = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytesHashed += chunk.length;
      onProgress?.(bytesHashed);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function scanArchive({
  hashFiles = false,
  onProgress,
  sourceRoot,
}: ScanArchiveOptions): Promise<ScanArchiveResult> {
  const root = path.resolve(sourceRoot);
  const items: MediaItem[] = [];
  const skippedEntries: SkippedArchiveEntry[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (isSystemJunkDirectory(entry.name)) {
          continue;
        }
        await walk(absolutePath);
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

      const mediaType = detectMediaType(entry.name);
      if (!mediaType) {
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

      const fileStat = await stat(absolutePath);
      const parentPath = getParentPath(relativePath);
      const sha256 = hashFiles
        ? await hashFile({
            filePath: absolutePath,
            onProgress: (bytesHashed) =>
              onProgress?.({
                bytesHashed,
                fileSize: fileStat.size,
                filesFound: items.length,
                path: relativePath,
                skipped: skippedEntries.length,
                stage: "hashing",
              }),
          })
        : undefined;

      items.push({
        id: sha256 ?? relativePath,
        path: relativePath,
        parentPath,
        name: entry.name,
        extension: getExtension(entry.name),
        mediaType,
        size: fileStat.size,
        mtimeMs: Math.trunc(fileStat.mtimeMs),
        sha256,
      });
      onProgress?.({
        filesFound: items.length,
        path: relativePath,
        skipped: skippedEntries.length,
        stage: "scanning",
      });
    }
  }

  await walk(root);

  return {
    items,
    skipped: skippedEntries.length,
    skippedEntries,
    sourceRoot: root,
  };
}
