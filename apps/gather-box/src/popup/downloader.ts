import { prepareDownloadImage } from "../shared/download-policy";
import type { SiteKey } from "../shared/sites";
import type { GalleryImage } from "../shared/types";
import { formatError } from "./errors";

export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;

export interface DownloadSummary {
  saved: number;
  failed: number;
  skipped: number;
  failedItems: DownloadFailure[];
}

export interface DownloadFailure {
  fileName: string;
  reason: string;
  originalUrl?: string;
}

export interface DownloadCallbacks {
  onStart(total: number): void;
  onProgress(completed: number, total: number): void;
  onSaved(fileName: string): void;
  onSkipped?(fileName: string): void;
  onVerbose?(message: string): void;
}

export interface DownloadOptions {
  credentials?: RequestCredentials;
  concurrency?: number;
  site?: SiteKey;
  skipExistingFiles?: boolean;
}

export async function downloadImages(
  images: GalleryImage[],
  destinationDirectory: FileSystemDirectoryHandle,
  callbacks: DownloadCallbacks,
  options: DownloadOptions = {}
): Promise<DownloadSummary> {
  const summary: DownloadSummary = {
    saved: 0,
    failed: 0,
    skipped: 0,
    failedItems: []
  };
  let completed = 0;
  const total = images.length;
  const concurrency = options.concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY;

  callbacks.onStart(total);

  await runPool(images, concurrency, async (image) => {
    try {
      const preparedImage = options.site ? prepareDownloadImage(options.site, image) : image;
      if (!preparedImage) {
        throw new Error("Download URL or filename is not allowed");
      }

      if (
        options.skipExistingFiles &&
        (await fileExists(destinationDirectory, preparedImage.fileName))
      ) {
        summary.skipped += 1;
        callbacks.onSkipped?.(preparedImage.fileName);
        callbacks.onVerbose?.(`Skipped existing file ${preparedImage.fileName}`);
        return;
      }

      callbacks.onVerbose?.(`Fetching ${preparedImage.originalUrl}`);
      const response = await fetch(preparedImage.originalUrl, {
        credentials: options.credentials ?? "omit",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const fileHandle = await destinationDirectory.getFileHandle(preparedImage.fileName, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      summary.saved += 1;
      callbacks.onSaved(preparedImage.fileName);
    } catch (error) {
      summary.failed += 1;
      summary.failedItems.push({
        fileName: image.fileName,
        reason: formatError(error),
        originalUrl: image.originalUrl,
      });
    } finally {
      completed += 1;
      callbacks.onProgress(completed, total);
    }
  });

  return summary;
}

export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
}

export async function getOrCreateNestedDirectory(
  rootDirectory: FileSystemDirectoryHandle,
  segments: string[]
): Promise<FileSystemDirectoryHandle> {
  let currentDirectory = rootDirectory;

  for (const segment of segments) {
    currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create: true });
  }

  return currentDirectory;
}

async function fileExists(
  destinationDirectory: FileSystemDirectoryHandle,
  fileName: string
): Promise<boolean> {
  try {
    await destinationDirectory.getFileHandle(fileName);
    return true;
  } catch {
    return false;
  }
}
