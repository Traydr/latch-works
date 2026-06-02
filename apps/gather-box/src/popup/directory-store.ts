import type { SiteKey } from "../shared/sites";

const DB_NAME = "comic-downloader";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const DIRECTORY_KEY_PREFIX = "last-directory:";

export async function saveDirectoryHandle(
  siteKey: SiteKey | null,
  directoryHandle: FileSystemDirectoryHandle
): Promise<void> {
  const directoryKey = getDirectoryKey(siteKey);
  if (!directoryKey) {
    return;
  }

  const database = await openDatabase();
  await requestResult(
    database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(directoryHandle, directoryKey)
  );
}

export async function loadDirectoryHandle(
  siteKey: SiteKey | null
): Promise<FileSystemDirectoryHandle | null> {
  const directoryKey = getDirectoryKey(siteKey);
  if (!directoryKey) {
    return null;
  }

  const database = await openDatabase();
  return requestResult<FileSystemDirectoryHandle | undefined>(
    database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(directoryKey)
  ).then((handle) => handle || null);
}

export async function ensureDirectoryPermission(
  directoryHandle: FileSystemDirectoryHandle
): Promise<boolean> {
  const options: FileSystemHandlePermissionDescriptor = { mode: "readwrite" };

  if (typeof directoryHandle.queryPermission === "function") {
    const currentPermission = await directoryHandle.queryPermission(options);
    if (currentPermission === "granted") {
      return true;
    }
  }

  if (typeof directoryHandle.requestPermission === "function") {
    const requestedPermission = await directoryHandle.requestPermission(options);
    return requestedPermission === "granted";
  }

  return false;
}

function getDirectoryKey(siteKey: SiteKey | null): string | null {
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
