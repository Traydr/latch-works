import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChosenDirectory,
  clearProfileDirectories,
  getDirectoryDestinationId,
  loadDirectoryHandle,
  saveDirectoryHandle,
} from "./directory-store";
import type { FolderScope } from "./gather-run";
import { DEFAULT_PROFILE_ID } from "./profiles";

/**
 * Just enough IndexedDB for the handle store: one shared key-value store whose requests apply in
 * the order they are issued and report success on a later task, as the browser's do. Every
 * extension context shares it, so interleaved calls stand in for separate windows.
 */
interface MemoryRequest<T> {
  result: T;
  onsuccess: (() => void) | null;
}

const GLOBAL: FolderScope = { kind: "global" };

const PIXIV: FolderScope = { kind: "site", siteKey: "pixiv" };

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
    delete: (key: string) => request(() => entries.delete(key) && undefined),
  };

  const database = { transaction: () => ({ objectStore: () => store }) };

  vi.stubGlobal("indexedDB", { open: () => request(() => database) });

  return entries;
}

/**
 * A chosen folder, compared by name. A folder created with `hold` answers the sameness check only
 * once the hold is released, as a slow native comparison would; `onCompare` reports the check.
 */
function folder(
  name: string,
  hold?: Promise<void>,
  onCompare?: () => void,
): ChosenDirectory & { name: string } {
  return {
    name,
    async isSameEntry(other) {
      onCompare?.();
      await hold;

      return other.name === name;
    },
  };
}

describe("remembered destination folders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the destination ID when the same folder is chosen again", async () => {
    installMemoryIndexedDb();
    await saveDirectoryHandle(GLOBAL, folder("A"), DEFAULT_PROFILE_ID);
    const queuedId = await getDirectoryDestinationId(GLOBAL, DEFAULT_PROFILE_ID);

    await saveDirectoryHandle(GLOBAL, folder("A"), DEFAULT_PROFILE_ID);

    expect(await getDirectoryDestinationId(GLOBAL, DEFAULT_PROFILE_ID)).toBe(queuedId);
  });

  it("keeps each profile's folders apart, with Default on the pre-profile keys", async () => {
    const entries = installMemoryIndexedDb();
    await saveDirectoryHandle(PIXIV, folder("Default archive"), DEFAULT_PROFILE_ID);
    await saveDirectoryHandle(PIXIV, folder("Work archive"), "work");

    expect((await loadDirectoryHandle(PIXIV, DEFAULT_PROFILE_ID))?.name).toBe("Default archive");
    expect((await loadDirectoryHandle(PIXIV, "work"))?.name).toBe("Work archive");
    expect(await getDirectoryDestinationId(PIXIV, "work")).not.toBe(
      await getDirectoryDestinationId(PIXIV, DEFAULT_PROFILE_ID),
    );

    await clearProfileDirectories("work");

    expect(await loadDirectoryHandle(PIXIV, "work")).toBeNull();
    expect((await loadDirectoryHandle(PIXIV, DEFAULT_PROFILE_ID))?.name).toBe("Default archive");
    // A folder remembered before profiles existed is found under the default profile.
    expect(entries.get("last-directory:pixiv")).toMatchObject({ name: "Default archive" });
  });

  it("never pairs a folder with an ID another window gave a different folder", async () => {
    installMemoryIndexedDb();
    let releaseCompare: () => void = () => undefined;

    const compareHeld = new Promise<void>((resolve) => {
      releaseCompare = resolve;
    });

    await saveDirectoryHandle(GLOBAL, folder("A"), DEFAULT_PROFILE_ID);

    // One window reselects A to renew access; its comparison with the remembered A is still open.
    let comparing = false;

    const renewing = saveDirectoryHandle(
      GLOBAL,
      folder("A", compareHeld, () => {
        comparing = true;
      }),
      DEFAULT_PROFILE_ID,
    );

    await vi.waitFor(() => expect(comparing).toBe(true));

    // Meanwhile another window chooses B and queues a page for it.
    await saveDirectoryHandle(GLOBAL, folder("B"), DEFAULT_PROFILE_ID);
    const queuedForB = await getDirectoryDestinationId(GLOBAL, DEFAULT_PROFILE_ID);
    releaseCompare();
    await renewing;

    const remembered = await loadDirectoryHandle(GLOBAL, DEFAULT_PROFILE_ID);
    const rememberedId = await getDirectoryDestinationId(GLOBAL, DEFAULT_PROFILE_ID);

    expect(remembered?.name).toBe("A");
    expect(rememberedId).not.toBe(queuedForB);
  });
});
