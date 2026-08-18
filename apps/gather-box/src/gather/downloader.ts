import { z } from "zod";
import { prepareDownloadImage } from "../shared/download-policy";
import type { SiteKey } from "../shared/sites";
import type { GalleryImage } from "../shared/types";
import { formatError, isAbortError, throwIfAborted, toError } from "./errors";
import {
  IDENTITY_MEDIA_TRANSFORMER,
  type MediaTransformer
} from "./media-transformer";

export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;

/**
 * The slice of the File System Access API this module writes through. Naming it keeps the
 * download path independent of the rest of a browser handle, which it never touches.
 */
export interface WritableFileStream {
  write(data: FileSystemWriteChunkType): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface WritableFile {
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFileStream>;
}

export interface WritableDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFile>;
  removeEntry(name: string): Promise<void>;
}

/** Only the archive root is walked segment by segment; the leaf folder is written to directly. */
export interface NestableDirectory extends WritableDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<NestableDirectory>;
}

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
  mediaTransformer?: MediaTransformer;
  site?: SiteKey;
  signal?: AbortSignal;
}

export interface CollisionSaveResult {
  fileName: string;
  skipped: boolean;
}

export async function downloadImages(
  images: GalleryImage[],
  destinationDirectory: WritableDirectory,
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
  const mediaTransformer = options.mediaTransformer ?? IDENTITY_MEDIA_TRANSFORMER;
  let saveQueue = Promise.resolve();

  const enqueueSave = <T>(task: () => Promise<T>): Promise<T> => {
    const result = saveQueue.then(task);
    saveQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  callbacks.onStart(total);
  throwIfAborted(options.signal);

  await runPool(images, concurrency, async (image) => {
    try {
      throwIfAborted(options.signal);
      const preparedImage = options.site ? prepareDownloadImage(options.site, image) : image;
      if (!preparedImage) {
        throw new Error("Download URL or filename is not allowed");
      }

      const expectedTarget = mediaTransformer.expectedTarget(preparedImage.fileName);
      if (
        expectedTarget &&
        (await getExistingFileHandle(destinationDirectory, expectedTarget)) &&
        !(await hasPendingBlobCommit(destinationDirectory, expectedTarget))
      ) {
        summary.skipped += 1;
        callbacks.onSkipped?.(expectedTarget);
        callbacks.onVerbose?.(`Skipped existing converted file ${expectedTarget}`);
        return;
      }

      callbacks.onVerbose?.(`Fetching ${preparedImage.originalUrl}`);
      const response = await fetch(preparedImage.originalUrl, {
        credentials: options.credentials ?? "omit",
        signal: options.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const downloadedBlob = await response.blob();
      const transformed = await mediaTransformer.transform(
        downloadedBlob,
        preparedImage.fileName,
        options.signal
      );
      if (transformed.converted) {
        callbacks.onVerbose?.(
          `Converted ${preparedImage.fileName} to ${transformed.fileName}`
        );
      }
      throwIfAborted(options.signal);
      const saved = await enqueueSave(() =>
        saveBlobWithoutClobbering(
          transformed.blob,
          destinationDirectory,
          transformed.fileName,
          undefined,
          options.signal
        )
      );
      if (saved.skipped) {
        summary.skipped += 1;
        callbacks.onSkipped?.(saved.fileName);
        callbacks.onVerbose?.(`Skipped identical existing file ${saved.fileName}`);
        return;
      }

      summary.saved += 1;
      callbacks.onSaved(saved.fileName);
    } catch (error) {
      if (isAbortError(toError(error)) || options.signal?.aborted) {
        throw isAbortError(toError(error)) ? error : new DOMException("The operation was aborted.", "AbortError");
      }
      summary.failed += 1;
      summary.failedItems.push({
        fileName: image.fileName,
        reason: formatError(toError(error)),
        originalUrl: image.originalUrl,
      });
    } finally {
      completed += 1;
      callbacks.onProgress(completed, total);
    }
  });

  throwIfAborted(options.signal);
  return summary;
}

export async function saveBlobWithoutClobbering(
  blob: Blob,
  destinationDirectory: WritableDirectory,
  preferredFileName: string,
  randomSuffix: () => string = createRandomSuffix,
  signal?: AbortSignal
): Promise<CollisionSaveResult> {
  throwIfAborted(signal);
  const recovered = await recoverPendingBlobCommit(
    destinationDirectory,
    preferredFileName,
    blob,
    signal
  );
  if (recovered) {
    return { fileName: recovered, skipped: false };
  }

  const preferredHandle = await getExistingFileHandle(destinationDirectory, preferredFileName);
  if (!preferredHandle) {
    await commitBlob(destinationDirectory, preferredFileName, preferredFileName, blob, signal);
    return { fileName: preferredFileName, skipped: false };
  }

  if (await fileContentsMatch(preferredHandle, blob)) {
    return { fileName: preferredFileName, skipped: true };
  }

  for (let attempt = 0; attempt < 128; attempt += 1) {
    throwIfAborted(signal);
    const candidateName = addFileNameSuffix(preferredFileName, randomSuffix());
    const candidateHandle = await getExistingFileHandle(destinationDirectory, candidateName);
    if (!candidateHandle) {
      await commitBlob(destinationDirectory, preferredFileName, candidateName, blob, signal);
      return { fileName: candidateName, skipped: false };
    }

    if (await fileContentsMatch(candidateHandle, blob)) {
      return { fileName: candidateName, skipped: true };
    }
  }

  throw new Error(`Could not find an unused filename for ${preferredFileName}`);
}

export function addFileNameSuffix(fileName: string, suffix: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${fileName}_${suffix}`;
  }

  return `${fileName.slice(0, dotIndex)}_${suffix}${fileName.slice(dotIndex)}`;
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
  rootDirectory: NestableDirectory,
  segments: string[]
): Promise<NestableDirectory> {
  let currentDirectory = rootDirectory;

  for (const segment of segments) {
    currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create: true });
  }

  return currentDirectory;
}

async function getExistingFileHandle(
  destinationDirectory: WritableDirectory,
  fileName: string
): Promise<WritableFile | null> {
  try {
    return await destinationDirectory.getFileHandle(fileName);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return null;
    }
    throw error;
  }
}

async function fileContentsMatch(fileHandle: WritableFile, blob: Blob): Promise<boolean> {
  try {
    const existingFile = await fileHandle.getFile();
    if (existingFile.size !== blob.size) {
      return false;
    }

    const existingHash = await hashBlob(existingFile);
    const incomingHash = await hashBlob(blob);
    return existingHash === incomingHash;
  } catch {
    return false;
  }
}

async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Written next to a partially saved file so an interrupted write can be finished or rolled back. */
const CommitMarkerSchema = z.object({
  preferredFileName: z.string(),
  targetFileName: z.string()
});

async function commitBlob(
  destinationDirectory: WritableDirectory,
  preferredFileName: string,
  targetFileName: string,
  blob: Blob,
  signal?: AbortSignal
): Promise<void> {
  const markerName = await getCommitMarkerName(preferredFileName);
  const marker = new Blob([JSON.stringify({ preferredFileName, targetFileName })], {
    type: "application/json"
  });
  await writeBlobDirect(destinationDirectory, markerName, marker, signal);
  try {
    await writeBlobDirect(destinationDirectory, targetFileName, blob, signal);
    await removeEntryIfPresent(destinationDirectory, markerName);
  } catch (error) {
    if (isAbortError(toError(error)) || signal?.aborted) {
      await removeEntryIfPresent(destinationDirectory, targetFileName);
      await removeEntryIfPresent(destinationDirectory, markerName);
    }
    throw error;
  }
}

async function hasPendingBlobCommit(
  destinationDirectory: WritableDirectory,
  preferredFileName: string
): Promise<boolean> {
  return Boolean(
    await getExistingFileHandle(destinationDirectory, await getCommitMarkerName(preferredFileName))
  );
}

async function recoverPendingBlobCommit(
  destinationDirectory: WritableDirectory,
  preferredFileName: string,
  blob: Blob,
  signal?: AbortSignal
): Promise<string | null> {
  const markerName = await getCommitMarkerName(preferredFileName);
  const markerHandle = await getExistingFileHandle(destinationDirectory, markerName);
  if (!markerHandle) {
    return null;
  }

  let targetFileName: string | null = null;
  try {
    const marker = CommitMarkerSchema.parse(JSON.parse(await (await markerHandle.getFile()).text()));
    if (
      marker.preferredFileName === preferredFileName &&
      isSafeCommitTarget(marker.targetFileName)
    ) {
      targetFileName = marker.targetFileName;
    }
  } catch {
    // An incomplete marker means the canonical file was never opened.
  }

  if (!targetFileName) {
    await removeEntryIfPresent(destinationDirectory, markerName);
    return null;
  }

  throwIfAborted(signal);
  const targetHandle = await getExistingFileHandle(destinationDirectory, targetFileName);
  if (!targetHandle || !(await fileContentsMatch(targetHandle, blob))) {
    await removeEntryIfPresent(destinationDirectory, targetFileName);
    await writeBlobDirect(destinationDirectory, targetFileName, blob, signal);
  }
  await removeEntryIfPresent(destinationDirectory, markerName);
  return targetFileName;
}

async function getCommitMarkerName(preferredFileName: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(preferredFileName)
  );
  const key = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `.gather-box-commit-${key}.json`;
}

function isSafeCommitTarget(fileName: string): boolean {
  return fileName.length > 0 && fileName !== "." && fileName !== ".." && !/[\\/]/.test(fileName);
}

async function removeEntryIfPresent(
  destinationDirectory: WritableDirectory,
  fileName: string
): Promise<void> {
  try {
    await destinationDirectory.removeEntry(fileName);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      throw error;
    }
  }
}

async function writeBlobDirect(
  destinationDirectory: WritableDirectory,
  fileName: string,
  blob: Blob,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const fileHandle = await destinationDirectory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    throwIfAborted(signal);
    await writable.write(blob);
    // close() commits the File System Access write — if cancel landed during write, abort instead.
    throwIfAborted(signal);
    await writable.close();
  } catch (error) {
    await closeWritableSafely(writable);
    throw error;
  }
}

async function closeWritableSafely(writable: WritableFileStream): Promise<void> {
  try {
    const abort = writable.abort;
    if (abort) {
      await abort.call(writable);
      return;
    }
    await writable.close();
  } catch {
    // Best-effort cleanup after a failed or aborted write.
  }
}

function createRandomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const randomBytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(randomBytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
