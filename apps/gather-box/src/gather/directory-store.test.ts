import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDirectoryDestinationId,
  loadDirectoryHandle,
  saveDirectoryHandle
} from "./directory-store";

/**
 * Just enough IndexedDB for the handle store: one shared key-value store whose requests apply in
 * the order they are issued and report success on a later task, as the browser's do. Every
 * extension context shares it, so interleaved calls stand in for separate windows.
 */
function installMemoryIndexedDb(): void {
  const entries = new Map<IDBValidKey, unknown>();

  const request = <T>(apply: () => T): IDBRequest<T> => {
    const pending = { result: undefined as T, onsuccess: null as (() => void) | null };
    pending.result = apply();
    setTimeout(() => pending.onsuccess?.(), 0);

    return pending as unknown as IDBRequest<T>;
  };

  const store = {
    get: (key: IDBValidKey) => request(() => entries.get(key)),
    count: (key: IDBValidKey) => request(() => (entries.has(key) ? 1 : 0)),
    put: (value: unknown, key: IDBValidKey) => request(() => entries.set(key, value) && key),
    delete: (key: IDBValidKey) => request(() => entries.delete(key) && undefined)
  };

  const database = { transaction: () => ({ objectStore: () => store }) };

  vi.stubGlobal("indexedDB", {
    open: () => request(() => database)
  });
}

/**
 * A folder handle. Comparing any folder against one created with `hold` waits for it, as a slow
 * native sameness check would.
 */
function folder(name: string, hold?: Promise<void>): FileSystemDirectoryHandle {
  const handle = {
    name,
    hold,
    isSameEntry: async (other: { name: string; hold?: Promise<void> }) => {
      await other.hold;

      return other.name === name;
    }
  };

  return handle as unknown as FileSystemDirectoryHandle;
}

describe("remembered destination folders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the destination ID when the same folder is chosen again", async () => {
    installMemoryIndexedDb();
    await saveDirectoryHandle(null, folder("A"), true);
    const queuedId = await getDirectoryDestinationId(null, true);

    await saveDirectoryHandle(null, folder("A"), true);

    expect(await getDirectoryDestinationId(null, true)).toBe(queuedId);
  });

  it("never pairs a folder with an ID another window gave a different folder", async () => {
    installMemoryIndexedDb();
    let releaseCompare: () => void = () => undefined;

    const compareHeld = new Promise<void>((resolve) => {
      releaseCompare = resolve;
    });

    await saveDirectoryHandle(null, folder("A"), true);

    // One window reselects A to renew access; its comparison with the remembered A is still open.
    const renewing = saveDirectoryHandle(null, folder("A", compareHeld), true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Meanwhile another window chooses B and queues a page for it.
    await saveDirectoryHandle(null, folder("B"), true);
    const queuedForB = await getDirectoryDestinationId(null, true);
    releaseCompare();
    await renewing;

    const remembered = await loadDirectoryHandle(null, true);
    const rememberedId = await getDirectoryDestinationId(null, true);

    expect(remembered?.name).toBe("A");
    expect(rememberedId).not.toBe(queuedForB);
  });
});
