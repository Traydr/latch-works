import * as z from "zod/mini";
import { toError } from "./errors";
import { DEFAULT_PROFILE_ID } from "../shared/profiles";
import type { SiteKey } from "../shared/sites";
import { GATHER_SOURCES } from "../shared/source-catalog";

const DB_NAME = "comic-downloader";

const DB_VERSION = 1;

const STORE_NAME = "handles";

const DIRECTORY_KEY_PREFIX = "last-directory:";

/** Folders of profiles other than the default one live under their own namespace. */
const PROFILE_KEY_PREFIX = `${DIRECTORY_KEY_PREFIX}profile:`;

/** Names which folder a scope's remembered handle currently points at; replaced on every pick. */
const DESTINATION_ID_KEY_PREFIX = "destination-id:";

const DestinationIdSchema = z.string();

export type DirectoryPermissionResult = "granted" | "requires-user-activation" | "denied";

/** The permission surface of a directory handle — the only part this check reads. */
export type PermissionedDirectoryHandle = Pick<
  FileSystemDirectoryHandle,
  "queryPermission" | "requestPermission"
>;

/** The part of a chosen folder handle a pick reads: whether it is the folder already remembered. */
export interface ChosenDirectory {
  isSameEntry(other: FileSystemHandle): Promise<boolean>;
}

/** A remembered folder and the destination ID it was given, always read and written together. */
export interface RememberedDestination {
  handle: FileSystemDirectoryHandle;
  id: string;
}

/** How often a pick re-reads the remembered folder after another context changed it mid-compare. */
const SAVE_ATTEMPTS = 8;

export async function saveDirectoryHandle(
  siteKey: SiteKey | null,
  directoryHandle: ChosenDirectory,
  useGlobalFolder: boolean,
  profileId: string
): Promise<void> {
  const directoryKey = getDirectoryKey(siteKey, useGlobalFolder, profileId);

  if (!directoryKey) {
    return;
  }

  const idKey = DESTINATION_ID_KEY_PREFIX + directoryKey;

  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const previous = await readStoredDestination(await openStore("readonly"), directoryKey);

    // Choosing the same folder again, such as to renew access, keeps queued outputs pointed at it.
    // The comparison runs outside any transaction, so the ID is kept only if the remembered
    // folder is still the one compared when the write commits.
    const sameFolder = previous.handle
      ? await directoryHandle.isSameEntry(previous.handle).catch(() => false)
      : false;

    const store = await openStore("readwrite");
    const current = await readStoredDestination(store, directoryKey);

    if (current.id !== previous.id) {
      continue;
    }

    if (!sameFolder || current.id === undefined) {
      store.put(crypto.randomUUID(), idKey);
    }

    await requestResult(store.put(directoryHandle, directoryKey));

    return;
  }

  throw new Error("The remembered folder kept changing in another window. Choose it again.");
}

/**
 * Identifies the folder a scope is remembered as right now, without reading the handle itself, so
 * the service worker can record which destination a queued output was gathered for. Null when no
 * folder is remembered. A handle saved by an older build gets its identifier on first read.
 */
export async function getDirectoryDestinationId(
  siteKey: SiteKey | null,
  useGlobalFolder: boolean,
  profileId: string
): Promise<string | null> {
  const directoryKey = getDirectoryKey(siteKey, useGlobalFolder, profileId);

  if (!directoryKey) {
    return null;
  }

  const store = await openStore("readwrite");
  const handleCount = await requestResult(store.count(directoryKey));

  if (handleCount === 0) {
    return null;
  }

  return ensureDestinationId(store, directoryKey);
}

/**
 * The remembered folder and its destination ID from one transaction, so a queued output checks
 * its ID against the very handle it would write into. Null when no folder is remembered.
 */
export async function loadDirectoryDestination(
  siteKey: SiteKey | null,
  useGlobalFolder: boolean,
  profileId: string
): Promise<RememberedDestination | null> {
  const directoryKey = getDirectoryKey(siteKey, useGlobalFolder, profileId);

  if (!directoryKey) {
    return null;
  }

  const store = await openStore("readwrite");
  const handle = await requestResult<FileSystemDirectoryHandle | undefined>(store.get(directoryKey));

  if (!handle) {
    return null;
  }

  return { handle, id: await ensureDestinationId(store, directoryKey) };
}

export async function loadDirectoryHandle(
  siteKey: SiteKey | null,
  useGlobalFolder: boolean,
  profileId: string
): Promise<FileSystemDirectoryHandle | null> {
  const directoryKey = getDirectoryKey(siteKey, useGlobalFolder, profileId);

  if (!directoryKey) {
    return null;
  }

  const database = await openDatabase();

  return requestResult<FileSystemDirectoryHandle | undefined>(
    database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(directoryKey)
  ).then((handle) => handle || null);
}

export async function clearDirectoryHandle(
  siteKey: SiteKey | null,
  useGlobalFolder: boolean,
  profileId: string
): Promise<void> {
  const directoryKey = getDirectoryKey(siteKey, useGlobalFolder, profileId);

  if (!directoryKey) {
    return;
  }

  const database = await openDatabase();
  const store = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
  store.delete(DESTINATION_ID_KEY_PREFIX + directoryKey);
  await requestResult(store.delete(directoryKey));
}

/** Forgets every folder a profile remembers, for when the profile itself is removed. */
export async function clearProfileDirectories(profileId: string): Promise<void> {
  const directoryKeys = [
    getDirectoryKey(null, true, profileId),
    ...GATHER_SOURCES.map((source) => getDirectoryKey(source.key, false, profileId))
  ].filter((key) => key !== null);

  const store = await openStore("readwrite");

  const deletions = directoryKeys.flatMap((key) => [
    store.delete(DESTINATION_ID_KEY_PREFIX + key),
    store.delete(key)
  ]);

  await Promise.all(deletions.map((request) => requestResult(request)));
}

export async function ensureDirectoryPermission(
  directoryHandle: PermissionedDirectoryHandle,
  allowPermissionPrompt = true
): Promise<DirectoryPermissionResult> {
  const options: FileSystemHandlePermissionDescriptor = { mode: "readwrite" };

  try {
    // requestPermission must be invoked before the first await in a click/key handler or Chrome may
    // discard the transient activation. Calling it for an already-granted handle is harmless.
    const requestPermission = directoryHandle.requestPermission;

    if (allowPermissionPrompt && requestPermission) {
      const requestedPermission = await requestPermission.call(directoryHandle, options);

      return requestedPermission === "granted" ? "granted" : "denied";
    }

    const queryPermission = directoryHandle.queryPermission;

    if (queryPermission) {
      const currentPermission = await queryPermission.call(directoryHandle, options);

      if (currentPermission === "granted") {
        return "granted";
      }
    }

    if (!allowPermissionPrompt) {
      return "requires-user-activation";
    }
  } catch (error) {
    return isUserActivationError(toError(error)) ? "requires-user-activation" : "denied";
  }

  return "denied";
}

export function getDirectoryScopeLabel(useGlobalFolder: boolean): string {
  return useGlobalFolder ? "all sites" : "this site";
}

function getDirectoryKey(
  siteKey: SiteKey | null,
  useGlobalFolder: boolean,
  profileId: string
): string | null {
  const scope = useGlobalFolder ? "global" : siteKey;

  if (!scope) {
    return null;
  }

  return profileId === DEFAULT_PROFILE_ID
    ? DIRECTORY_KEY_PREFIX + scope
    : `${PROFILE_KEY_PREFIX}${profileId}:${scope}`;
}

async function openStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const database = await openDatabase();

  return database.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

async function readStoredDestination(
  store: IDBObjectStore,
  directoryKey: string
): Promise<{ handle: FileSystemDirectoryHandle | null; id: string | undefined }> {
  const [handle, storedId] = await Promise.all([
    requestResult<FileSystemDirectoryHandle | undefined>(store.get(directoryKey)),
    requestResult<unknown>(store.get(DESTINATION_ID_KEY_PREFIX + directoryKey))
  ]);

  const parsedId = DestinationIdSchema.safeParse(storedId);

  return { handle: handle || null, id: parsedId.success ? parsedId.data : undefined };
}

/** A handle saved by an older build has no destination ID yet; it gets one on first read. */
async function ensureDestinationId(store: IDBObjectStore, directoryKey: string): Promise<string> {
  const idKey = DESTINATION_ID_KEY_PREFIX + directoryKey;
  const parsedId = DestinationIdSchema.safeParse(await requestResult<unknown>(store.get(idKey)));

  if (parsedId.success) {
    return parsedId.data;
  }

  const destinationId = crypto.randomUUID();
  await requestResult(store.put(destinationId, idKey));

  return destinationId;
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error || new Error("IndexedDB open failed."));
    };
  });
}

async function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error || new Error("IndexedDB request failed."));
    };
  });
}

/** Chrome refuses a permission prompt outside a user gesture with this exact SecurityError. */
function isUserActivationError(error: Error): boolean {
  return (
    error.name === "SecurityError" && error.message.toLowerCase().includes("user activation")
  );
}

/** The persisted-handle operations the popup and side panel depend on. */
export interface DirectoryStore {
  clearDirectoryHandle: typeof clearDirectoryHandle;
  ensureDirectoryPermission: typeof ensureDirectoryPermission;
  getDirectoryScopeLabel: typeof getDirectoryScopeLabel;
  loadDirectoryHandle: typeof loadDirectoryHandle;
  saveDirectoryHandle: typeof saveDirectoryHandle;
}

export const directoryStore = {
  clearDirectoryHandle,
  ensureDirectoryPermission,
  getDirectoryScopeLabel,
  loadDirectoryHandle,
  saveDirectoryHandle
} satisfies DirectoryStore;
