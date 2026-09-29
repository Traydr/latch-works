import * as z from "zod/mini";
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
  write(data: Blob): Promise<void>;
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
  onKeptOriginal?(fileName: string, reason: string): void;
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

      if (transformed.conversionFailure) {
        callbacks.onKeptOriginal?.(transformed.fileName, transformed.conversionFailure);
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
  const contentHash = await hashBlob(blob);

  for (let attempt = 0; attempt <= 128; attempt += 1) {
    throwIfAborted(signal);

    const candidateName =
      attempt === 0
        ? preferredFileName
        : addFileNameSuffix(
            preferredFileName,
            getContentSuffix(contentHash, attempt - 1) ?? randomSuffix()
          );

    const candidate = await claimCandidate(
      destinationDirectory,
      candidateName,
      blob,
      contentHash,
      signal
    );

    if (candidate === "free") {
      await commitBlob(destinationDirectory, candidateName, blob, contentHash, signal);

      return { fileName: candidateName, skipped: false };
    }

    if (candidate !== "taken") {
      return { fileName: candidateName, skipped: candidate === "identical" };
    }
  }

  throw new Error(`Could not find an unused filename for ${preferredFileName}`);
}

/**
 * What a candidate filename holds for this content. A commit marker left by an interrupted save
 * only authorizes rewriting its target when the marker records this exact content; anything else
 * at that name is an archive file and is never replaced.
 */
async function claimCandidate(
  destinationDirectory: WritableDirectory,
  fileName: string,
  blob: Blob,
  contentHash: string,
  signal?: AbortSignal
): Promise<"free" | "identical" | "repaired" | "taken"> {
  const markerName = await getCommitMarkerName(fileName);
  const marker = await readCommitMarker(destinationDirectory, markerName);
  const existing = await getExistingFileHandle(destinationDirectory, fileName);

  if (marker?.contentHash === contentHash) {
    // This content's own write was interrupted; finish it at the name it had claimed.
    if (!existing || !(await fileHasContent(existing, blob.size, contentHash))) {
      throwIfAborted(signal);
      await writeBlobDirect(destinationDirectory, fileName, blob, signal);
    }

    await removeEntryIfPresent(destinationDirectory, markerName);

    return "repaired";
  }

  if (marker && existing && !(await fileHasContent(existing, null, marker.contentHash))) {
    // Another item's write never finished. Leave the file and its marker for that item's replay.
    return "taken";
  }

  if (marker !== undefined) {
    // The marked write finished and only its cleanup was lost, its target was never created, or
    // the marker cannot be read (a marker is written before its target is opened, and older
    // builds did not record content). None of these proves an unfinished write of known content.
    await removeEntryIfPresent(destinationDirectory, markerName);
  }

  if (!existing) {
    return "free";
  }

  return (await fileHasContent(existing, blob.size, contentHash)) ? "identical" : "taken";
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

/** A file that cannot be read matches no content, so it is never treated as replaceable. */
async function fileHasContent(
  fileHandle: WritableFile,
  expectedSize: number | null,
  expectedHash: string
): Promise<boolean> {
  try {
    const file = await fileHandle.getFile();

    if (expectedSize !== null && file.size !== expectedSize) {
      return false;
    }

    return (await hashBlob(file)) === expectedHash;
  } catch {
    return false;
  }
}

async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Written before a file is opened and removed once it is complete. It is keyed by the target name
 * and records the content being written, so a replay can tell its own unfinished write apart from
 * a finished file that merely lost its marker.
 */
const CommitMarkerSchema = z.object({ contentHash: z.string() });

type CommitMarker = z.infer<typeof CommitMarkerSchema>;

async function commitBlob(
  destinationDirectory: WritableDirectory,
  targetFileName: string,
  blob: Blob,
  contentHash: string,
  signal?: AbortSignal
): Promise<void> {
  const markerName = await getCommitMarkerName(targetFileName);
  const record: CommitMarker = { contentHash };
  const marker = new Blob([JSON.stringify(record)], { type: "application/json" });

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
  targetFileName: string
): Promise<boolean> {
  return Boolean(
    await getExistingFileHandle(destinationDirectory, await getCommitMarkerName(targetFileName))
  );
}

/**
 * Undefined when there is no marker, null when one exists but cannot be read — including markers
 * from builds that did not record content — and the record otherwise.
 */
async function readCommitMarker(
  destinationDirectory: WritableDirectory,
  markerName: string
): Promise<CommitMarker | null | undefined> {
  const markerHandle = await getExistingFileHandle(destinationDirectory, markerName);

  if (!markerHandle) {
    return undefined;
  }

  try {
    return CommitMarkerSchema.parse(JSON.parse(await (await markerHandle.getFile()).text()));
  } catch {
    return null;
  }
}

async function getCommitMarkerName(targetFileName: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(targetFileName));

  const key = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  return `.gather-box-commit-${key}.json`;
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

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * The suffix a collision takes is derived from the content, so replaying the same content lands on
 * the same name and is skipped as identical. Each attempt reads the next four hash bytes; the
 * random fallback only covers the unlikely case that every derived name is already taken.
 */
function getContentSuffix(contentHash: string, index: number): string | null {
  const bytes = contentHash.slice(index * 8, index * 8 + 8).match(/../g);

  if (bytes?.length !== 4) {
    return null;
  }

  return bytes.map((byte) => SUFFIX_ALPHABET[Number.parseInt(byte, 16) % SUFFIX_ALPHABET.length]).join("");
}

function createRandomSuffix(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(4));

  return Array.from(randomBytes, (byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join("");
}
