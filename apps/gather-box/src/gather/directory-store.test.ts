import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE_ID } from "../shared/profiles";
import {
  type ChosenDirectory,
  clearProfileDirectories,
  getDirectoryDestinationId,
  loadDirectoryHandle,
  saveDirectoryHandle
} from "./directory-store";

/**
 * Just enough IndexedDB for the handle store: one shared key-value store whose requests apply in
 * the order they are issued and report success on a later task, as the browser's do. Every
 * extension context shares it, so interleaved calls stand in for separate windows.
 */
interface MemoryRequest<T> {
  result: T;
  onsuccess: (() => void) | null;
}

/** A stored folder handle or destination ID. */
type StoredValue = ChosenDirectory | string;

function installMemoryIndexedDb(): Map<string, StoredValue> {
  const entries = new Map<string, StoredValue>();

  const request = <T>(apply: () => T): MemoryRequest<T> => {
    const pending: MemoryRequest<T> = { result: apply(), onsuccess: null };

    setTimeout(() => pending.onsuccess?.(), 0);

    return pending;
  };

  const store = {
    get: (key: string) => request(() => entries.get(key)),
    count: (key: string) => request(() => (entries.has(key) ? 1 : 0)),
    put: (value: StoredValue, key: string) => request(() => entries.set(key, value) && key),
    delete: (key: string) => request(() => entries.delete(key) && undefined)
  };

  const database = { transaction: () => ({ objectStore: () => store }) };

  vi.stubGlobal("indexedDB", { open: () => request(() => database) });

  return entries;
}

/**
 * A chosen folder, compared by name. A folder created with `hold` answers the sameness check only
 * once the hold is released, as a slow native comparison would.
 */
function folder(name: string, hold?: Promise<void>): ChosenDirectory & { name: string } {
  return {
    name,
    async isSameEntry(other) {
      await hold;

      return other.name === name;
    }
  };
}

describe("remembered destination folders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the destination ID when the same folder is chosen again", async () => {
    installMemoryIndexedDb();
    await saveDirectoryHandle(null, folder("A"), true, DEFAULT_PROFILE_ID);
    const queuedId = await getDirectoryDestinationId(null, true, DEFAULT_PROFILE_ID);

    await saveDirectoryHandle(null, folder("A"), true, DEFAULT_PROFILE_ID);

    expect(await getDirectoryDestinationId(null, true, DEFAULT_PROFILE_ID)).toBe(queuedId);
  });

  it("keeps each profile's folders apart, with Default on the pre-profile keys", async () => {
    const entries = installMemoryIndexedDb();
    await saveDirectoryHandle("pixiv", folder("Default archive"), false, DEFAULT_PROFILE_ID);
    await saveDirectoryHandle("pixiv", folder("Work archive"), false, "work");

    expect((await loadDirectoryHandle("pixiv", false, DEFAULT_PROFILE_ID))?.name).toBe(
      "Default archive"
    );
    expect((await loadDirectoryHandle("pixiv", false, "work"))?.name).toBe("Work archive");
    expect(await getDirectoryDestinationId("pixiv", false, "work")).not.toBe(
      await getDirectoryDestinationId("pixiv", false, DEFAULT_PROFILE_ID)
    );

    await clearProfileDirectories("work");

    expect(await loadDirectoryHandle("pixiv", false, "work")).toBeNull();
    expect((await loadDirectoryHandle("pixiv", false, DEFAULT_PROFILE_ID))?.name).toBe(
      "Default archive"
    );
    // A folder remembered before profiles existed is found under the default profile.
    expect(entries.get("last-directory:pixiv")).toMatchObject({ name: "Default archive" });
  });

  it("never pairs a folder with an ID another window gave a different folder", async () => {
    installMemoryIndexedDb();
    let releaseCompare: () => void = () => undefined;

    const compareHeld = new Promise<void>((resolve) => {
      releaseCompare = resolve;
    });

    await saveDirectoryHandle(null, folder("A"), true, DEFAULT_PROFILE_ID);

    // One window reselects A to renew access; its comparison with the remembered A is still open.
    const renewing = saveDirectoryHandle(null, folder("A", compareHeld), true, DEFAULT_PROFILE_ID);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Meanwhile another window chooses B and queues a page for it.
    await saveDirectoryHandle(null, folder("B"), true, DEFAULT_PROFILE_ID);
    const queuedForB = await getDirectoryDestinationId(null, true, DEFAULT_PROFILE_ID);
    releaseCompare();
    await renewing;

    const remembered = await loadDirectoryHandle(null, true, DEFAULT_PROFILE_ID);
    const rememberedId = await getDirectoryDestinationId(null, true, DEFAULT_PROFILE_ID);

    expect(remembered?.name).toBe("A");
    expect(rememberedId).not.toBe(queuedForB);
  });
});
