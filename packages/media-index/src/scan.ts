import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  detectMediaType,
  getExtension,
  getParentPath,
  joinArchivePath,
  type MediaItem,
} from "@latch-works/media-domain";

export interface ScanArchiveOptions {
  hashFiles?: boolean;
  sourceRoot: string;
}

export interface ScanArchiveResult {
  items: MediaItem[];
  skipped: number;
  sourceRoot: string;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function scanArchive({
  hashFiles = false,
  sourceRoot,
}: ScanArchiveOptions): Promise<ScanArchiveResult> {
  const root = path.resolve(sourceRoot);
  const items: MediaItem[] = [];
  let skipped = 0;

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }

      const mediaType = detectMediaType(entry.name);
      if (!mediaType) {
        skipped += 1;
        continue;
      }

      const fileStat = await stat(absolutePath);
      const relativePath = joinArchivePath(path.relative(root, absolutePath));
      const parentPath = getParentPath(relativePath);
      const sha256 = hashFiles ? await hashFile(absolutePath) : undefined;

      items.push({
        id: sha256 ?? relativePath,
        path: relativePath,
        parentPath,
        name: entry.name,
        extension: getExtension(entry.name),
        mediaType,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        sha256,
      });
    }
  }

  await walk(root);

  return {
    items,
    skipped,
    sourceRoot: root,
  };
}
