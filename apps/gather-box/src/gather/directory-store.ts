import * as z from "zod/mini";
import { toError } from "./errors";
import type { SiteKey } from "../shared/sites";

const DB_NAME = "comic-downloader";

const DB_VERSION = 1;

const STORE_NAME = "handles";

const DIRECTORY_KEY_PREFIX = "last-directory:";

export const GLOBAL_DIRECTORY_KEY = `${DIRECTORY_KEY_PREFIX}global`;

/** Names which folder a scope's remembered handle currently points at; replaced on every pick. */
const DESTINATION_ID_KEY_PREFIX = "destination-id:";

const DestinationIdSchema = z.string();

export type DirectoryPermissionResult = "granted" | "requires-user-activation" | "denied";

/** The permission surface of a directory handle — the only part this check reads. */
export type PermissionedDirectoryHandle = Pick<
  FileSystemDirectoryHandle,
  "queryPermission" | "requestPermission"
>;

export async function saveDirectoryHandle(
  siteKey: SiteKey | null,
  directoryHandle: FileSystemDirectoryHandle,
  useGlobalFolder: boolean
): Promise<void> {
  const directoryKey = getDirectoryKey(siteKey, useGlobalFolder);

  if (!directoryKey) {
    return;
  }

  // Choosing the same folder again, such as to renew access, keeps queued outputs pointed at it.
  const previous = await loadDirectoryHandle(siteKey, useGlobalFolder);

  const sameFolder = previous
    ? await previous.isSameEntry(directoryHandle).catch(() => false)
    : false;

  const database = await openDatabase();
  const store = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);

  if (!sameFolder) {
    store.put(crypto.randomUUID(), DESTINATION_ID_KEY_PREFIX + directoryKey);
  }

  await requestResult(store.put(directoryHandle, directoryKey));
}

/**
 * Identifies the folder a scope is remembered as right now, without reading the handle itself, so
 * the service worker can record which destination a queued output was gathered for. Null when no
 * folder is remembered. A handle saved by an older build gets its identifier on first read.
 */
export async function getDirectoryDestinationId(
  siteKey: SiteKey | null,
  useGlobalFolder: boolean
): Promise<string | null> {
  const directoryKey = getDirectoryKey(siteKey, useGlobalFolder);

  if (!directoryKey) {
    return null;
  }

  const database = await openDatabase();
  const store = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
  const idKey = DESTINATION_ID_KEY_PREFIX + directoryKey;

  const [handleCount, storedId] = await Promise.all([
    requestResult(store.count(directoryKey)),
    requestResult<unknown>(store.get(idKey))
  ]);

  if (handleCount === 0) {
    return null;
  }

  const parsedId = DestinationIdSchema.safeParse(storedId);

  if (parsedId.success) {
    return parsedId.data;
  }

  const destinationId = crypto.randomUUID();
  await requestResult(store.put(destinationId, idKey));

  return destinationId;
}

export async function loadDirectoryHandle(
  siteKey: SiteKey | null,
  useGlobalFolder: boolean
): Promise<FileSystemDirectoryHandle | null> {
  const directoryKey = getDirectoryKey(siteKey, useGlobalFolder);

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
  useGlobalFolder: boolean
): Promise<void> {
  const directoryKey = getDirectoryKey(siteKey, useGlobalFolder);

  if (!directoryKey) {
    return;
  }

  const database = await openDatabase();
  const store = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
  store.delete(DESTINATION_ID_KEY_PREFIX + directoryKey);
  await requestResult(store.delete(directoryKey));
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

function getDirectoryKey(siteKey: SiteKey | null, useGlobalFolder: boolean): string | null {
  if (useGlobalFolder) {
    return GLOBAL_DIRECTORY_KEY;
  }

  return siteKey ? DIRECTORY_KEY_PREFIX + siteKey : null;
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
