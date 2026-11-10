import * as z from "zod/mini";
import { isAbortError, throwIfAborted, toError } from "./errors";
import type { MediaTransformer } from "./media/media-transformer";

/**
 * Collision-safe archive writes, used by the offscreen executor and by the side panel when it
 * saves a file you hand back.
 */

/** The slice of the File System Access API these writes go through. */
export interface WritableFileStream {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
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

export interface CollisionSaveResult {
  fileName: string;
  skipped: boolean;
}

const WEB_PAGE_FILE = /\.(?:html?|xhtml)$/i;

const WEB_PAGE_TYPE = /^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i;

const WEB_PAGE_START = /^(?:\uFEFF)?\s*<(?:!doctype\s+html|html[\s>])/i;

interface SavableFileCandidate {
  blob: Blob;
  contentType: string;
  /** The name the file is saved under; a web page is only acceptable for an .html name. */
  fileName: string;
}

/**
 * A sign-in wall, interstitial, or error page can arrive with a successful status, and a file you
 * hand back can be the challenge page saved by mistake. Archiving either under a media filename
 * would report success for a file that cannot open, so the item fails instead.
 */
async function assertSavableFile(candidate: SavableFileCandidate): Promise<void> {
  const { blob, contentType, fileName } = candidate;

  if (blob.size === 0) {
    throw new Error("The file is empty");
  }

  if (WEB_PAGE_FILE.test(fileName)) {
    return;
  }

  const isWebPage =
    WEB_PAGE_TYPE.test(contentType) || WEB_PAGE_START.test(await blob.slice(0, 512).text());

  if (isWebPage) {
    throw new Error("The file is a web page, not the expected file");
  }
}

export interface ArchiveItem {
  blob: Blob;
  contentType: string;
  /** The sanitized name the source gives the item, before any conversion. */
  fileName: string;
}

export interface SavedArchiveItem extends CollisionSaveResult {
  /** The name the item had before conversion renamed it, when it did. */
  convertedFrom: string | null;
  /** Why the original was kept although the archive wanted it converted. */
  conversionFailure: string | null;
}

/**
 * What an item becomes in the archive, whether a gather fetched it or you handed it back: checked
 * for a web page in disguise, converted as the settings ask, then saved without clobbering.
 */
export async function saveArchiveItem(
  item: ArchiveItem,
  destinationDirectory: WritableDirectory,
  mediaTransformer: MediaTransformer,
  signal?: AbortSignal,
): Promise<SavedArchiveItem> {
  await assertSavableFile(item);

  const transformed = await mediaTransformer.transform(item.blob, item.fileName, signal);
  throwIfAborted(signal);

  const saved = await saveBlobWithoutClobbering(
    transformed.blob,
    destinationDirectory,
    transformed.fileName,
    signal,
  );

  return {
    ...saved,
    convertedFrom: transformed.converted ? item.fileName : null,
    conversionFailure: transformed.conversionFailure ?? null,
  };
}

export async function saveBlobWithoutClobbering(
  blob: Blob,
  destinationDirectory: WritableDirectory,
  preferredFileName: string,
  signal?: AbortSignal,
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
            getContentSuffix(contentHash, attempt - 1) ?? createRandomSuffix(),
          );

    const candidate = await withFileNameLock(destinationDirectory, candidateName, async () => {
      const claim = await claimCandidate(
        destinationDirectory,
        candidateName,
        blob,
        contentHash,
        signal,
      );

      if (claim === "free") {
        await commitBlob(destinationDirectory, candidateName, blob, contentHash, signal);
      }

      return claim;
    });

    if (candidate === "free") {
      return { fileName: candidateName, skipped: false };
    }

    if (candidate !== "taken") {
      return { fileName: candidateName, skipped: candidate === "identical" };
    }
  }

  throw new Error(`Could not find an unused filename for ${preferredFileName}`);
}

/**
 * Saves in flight per folder handle, keyed by folded filename. A name is only known to be free
 * until something writes it, so a claim and its commit run as one step per name: a second save
 * that wants the same name waits, then finds it taken (or identical) and moves on. Names are
 * folded because the default macOS file system treats `Photo.jpg` and `photo.jpg` as one file.
 */
const fileNameLocks = new WeakMap<WritableDirectory, Map<string, Promise<unknown>>>();

async function withFileNameLock<T>(
  destinationDirectory: WritableDirectory,
  fileName: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = fileName.normalize("NFC").toLowerCase();
  let locks = fileNameLocks.get(destinationDirectory);

  if (!locks) {
    locks = new Map();
    fileNameLocks.set(destinationDirectory, locks);
  }

  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);

  const settled = result.then(
    () => undefined,
    () => undefined,
  );

  locks.set(key, settled);

  try {
    return await result;
  } finally {
    if (locks.get(key) === settled) {
      locks.delete(key);
    }
  }
}

/**
 * What a candidate filename holds for this content. A File System Access write lands only when its
 * stream closes, so an interrupted write leaves its target missing or empty, never partial. A
 * commit marker therefore authorizes writing its target only while the target is missing or empty
 * and the marker records this exact content. Any file with bytes in it is an archive file and is
 * never replaced, whatever a marker says.
 */
async function claimCandidate(
  destinationDirectory: WritableDirectory,
  fileName: string,
  blob: Blob,
  contentHash: string,
  signal?: AbortSignal,
): Promise<"free" | "identical" | "repaired" | "taken"> {
  const markerName = await getCommitMarkerName(fileName);
  const marker = await readCommitMarker(destinationDirectory, markerName);
  const existing = await getExistingFileHandle(destinationDirectory, fileName);
  const unwritten = !existing || (await isEmptyFile(existing));

  if (marker?.contentHash === contentHash && unwritten) {
    // This content's own write was interrupted; finish it at the name it had claimed.
    throwIfAborted(signal);
    await writeBlobDirect(destinationDirectory, fileName, blob, signal);
    await removeEntryIfPresent(destinationDirectory, markerName);

    return "repaired";
  }

  if (marker && existing && unwritten) {
    // Another item's write never finished. Leave the file and its marker for that item's replay.
    return "taken";
  }

  if (marker !== undefined) {
    // The marked write finished and only its cleanup was lost, its target was never created, the
    // target now holds other bytes, or the marker cannot be read (older builds did not record
    // content). None of these proves an unfinished write that may be completed here.
    await removeEntryIfPresent(destinationDirectory, markerName);
  }

  if (!existing) {
    return "free";
  }

  return (await fileHasContent(existing, blob.size, contentHash)) ? "identical" : "taken";
}

function addFileNameSuffix(fileName: string, suffix: string): string {
  const dotIndex = fileName.lastIndexOf(".");

  if (dotIndex <= 0) {
    return `${fileName}_${suffix}`;
  }

  return `${fileName.slice(0, dotIndex)}_${suffix}${fileName.slice(dotIndex)}`;
}

export async function getOrCreateNestedDirectory(
  rootDirectory: NestableDirectory,
  segments: string[],
): Promise<NestableDirectory> {
  let currentDirectory = rootDirectory;

  for (const segment of segments) {
    currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create: true });
  }

  return currentDirectory;
}

export async function getExistingFileHandle(
  destinationDirectory: WritableDirectory,
  fileName: string,
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

/** A file that cannot be read is not known to be empty, so it is never treated as replaceable. */
async function isEmptyFile(fileHandle: WritableFile): Promise<boolean> {
  try {
    return (await fileHandle.getFile()).size === 0;
  } catch {
    return false;
  }
}

/** A file that cannot be read matches no content, so it is never treated as replaceable. */
async function fileHasContent(
  fileHandle: WritableFile,
  expectedSize: number,
  expectedHash: string,
): Promise<boolean> {
  try {
    const file = await fileHandle.getFile();

    if (file.size !== expectedSize) {
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
  signal?: AbortSignal,
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
      await removeEmptyEntry(destinationDirectory, targetFileName);
      await removeEntryIfPresent(destinationDirectory, markerName);
    }

    throw error;
  }
}

export async function hasPendingBlobCommit(
  destinationDirectory: WritableDirectory,
  targetFileName: string,
): Promise<boolean> {
  return Boolean(
    await getExistingFileHandle(destinationDirectory, await getCommitMarkerName(targetFileName)),
  );
}

/**
 * Undefined when there is no marker, null when one exists but cannot be read — including markers
 * from builds that did not record content — and the record otherwise.
 */
async function readCommitMarker(
  destinationDirectory: WritableDirectory,
  markerName: string,
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
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `.gather-box-commit-${key}.json`;
}

async function removeEntryIfPresent(
  destinationDirectory: WritableDirectory,
  fileName: string,
): Promise<void> {
  try {
    await destinationDirectory.removeEntry(fileName);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      throw error;
    }
  }
}

/** A cancelled write only takes back the empty file it created; a file with bytes stays. */
async function removeEmptyEntry(
  destinationDirectory: WritableDirectory,
  fileName: string,
): Promise<void> {
  const existing = await getExistingFileHandle(destinationDirectory, fileName);

  if (existing && (await isEmptyFile(existing))) {
    await removeEntryIfPresent(destinationDirectory, fileName);
  }
}

async function writeBlobDirect(
  destinationDirectory: WritableDirectory,
  fileName: string,
  blob: Blob,
  signal?: AbortSignal,
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
    await writable.abort();
  } catch {
    // The write already failed; that error, not the cleanup's, is the one reported.
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

  return bytes
    .map((byte) => SUFFIX_ALPHABET[Number.parseInt(byte, 16) % SUFFIX_ALPHABET.length])
    .join("");
}

function createRandomSuffix(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(4));

  return Array.from(randomBytes, (byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join("");
}
