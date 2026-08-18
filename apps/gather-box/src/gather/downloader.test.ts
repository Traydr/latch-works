import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addFileNameSuffix,
  downloadImages,
  saveBlobWithoutClobbering,
  type WritableDirectory
} from "./downloader";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collision-safe downloads", () => {
  it("skips an identical existing file after hashing", async () => {
    const directory = createMemoryDirectory({ "site-name.jpg": new Blob(["same bytes"]) });

    const result = await saveBlobWithoutClobbering(
      new Blob(["same bytes"]),
      directory.handle,
      "site-name.jpg"
    );

    expect(result).toEqual({ fileName: "site-name.jpg", skipped: true });
    expect([...directory.files.keys()]).toEqual(["site-name.jpg"]);
  });

  it("adds four characters before the extension when content differs", async () => {
    const directory = createMemoryDirectory({ "site-name.jpg": new Blob(["old bytes"]) });

    const result = await saveBlobWithoutClobbering(
      new Blob(["new bytes"]),
      directory.handle,
      "site-name.jpg",
      () => "a1b2"
    );

    expect(result).toEqual({ fileName: "site-name_a1b2.jpg", skipped: false });
    expect([...directory.files.keys()]).toEqual(["site-name.jpg", "site-name_a1b2.jpg"]);
  });

  it("supports names without an extension", () => {
    expect(addFileNameSuffix("site-name", "a1b2")).toBe("site-name_a1b2");
  });

  it("does not overwrite when concurrent downloads have the same site filename", async () => {
    const directory = createMemoryDirectory({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(new Blob([url])))
    );

    const summary = await downloadImages(
      [
        {
          pageNumber: 1,
          thumbnailUrl: null,
          originalUrl: "https://example.test/first",
          fileName: "site-name.jpg"
        },
        {
          pageNumber: 2,
          thumbnailUrl: null,
          originalUrl: "https://example.test/second",
          fileName: "site-name.jpg"
        }
      ],
      directory.handle,
      {
        onStart: () => undefined,
        onProgress: () => undefined,
        onSaved: () => undefined
      },
      { concurrency: 2 }
    );

    expect(summary).toMatchObject({ saved: 2, failed: 0, skipped: 0 });
    expect([...directory.files.keys()]).toHaveLength(2);
    expect([...directory.files.keys()]).toContain("site-name.jpg");
    expect([...directory.files.keys()].some((name) => /^site-name_[a-z0-9]{4}\.jpg$/.test(name)))
      .toBe(true);
  });

  it("does not fetch a source file when its converted archive target already exists", async () => {
    const directory = createMemoryDirectory({ "existing.avif": new Blob(["migrated bytes"]) });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const summary = await downloadImages(
      [
        {
          pageNumber: 1,
          thumbnailUrl: null,
          originalUrl: "https://example.test/existing.jpg",
          fileName: "existing.jpg"
        }
      ],
      directory.handle,
      {
        onStart: () => undefined,
        onProgress: () => undefined,
        onSaved: () => undefined,
        onSkipped: () => undefined
      },
      {
        mediaTransformer: {
          expectedTarget: () => "existing.avif",
          transform: async (blob, fileName) => ({ blob, fileName, converted: false })
        }
      }
    );

    expect(summary).toMatchObject({ saved: 0, failed: 0, skipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts in-flight downloads when the signal fires", async () => {
    const directory = createMemoryDirectory({});
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        await new Promise<void>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true }
          );
        });
        return new Response(new Blob(["late"]));
      })
    );

    const pending = downloadImages(
      [
        {
          pageNumber: 1,
          thumbnailUrl: null,
          originalUrl: "https://example.test/slow",
          fileName: "slow.jpg"
        }
      ],
      directory.handle,
      {
        onStart: () => undefined,
        onProgress: () => undefined,
        onSaved: () => undefined
      },
      { signal: controller.signal }
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect([...directory.files.keys()]).toHaveLength(0);
  });

  it("does not commit a file when cancelled after write and before close", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeStartedGate = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const abortSpy = vi.fn(async () => undefined);
    const closeSpy = vi.fn(async () => undefined);
    const files = new Map<string, Blob>();
    const handle = {
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!files.has(name) && !options?.create) {
          throw new DOMException("Not found", "NotFoundError");
        }
        if (!files.has(name)) {
          files.set(name, new Blob());
        }
        return {
          async getFile() {
            return new File([files.get(name) ?? new Blob()], name);
          },
          async createWritable() {
            let pending = new Blob();
            return {
              async write(data: Blob) {
                pending = data;
                writeStarted();
                await writeGate;
              },
              async close() {
                await closeSpy();
                files.set(name, pending);
              },
              async abort() {
                await abortSpy();
              }
            };
          }
        };
      },
      async removeEntry(name: string) {
        files.delete(name);
      }
    } satisfies WritableDirectory;

    const controller = new AbortController();
    const pending = saveBlobWithoutClobbering(
      new Blob(["payload"]),
      handle,
      "cancelled.jpg",
      undefined,
      controller.signal
    );

    await writeStartedGate;
    controller.abort();
    releaseWrite();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(closeSpy).not.toHaveBeenCalled();
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(files.get("cancelled.jpg")?.size ?? 0).toBe(0);
  });

  it("repairs a known incomplete canonical file instead of creating a suffix", async () => {
    const files = new Map<string, Blob>();
    let failCanonicalOnce = true;
    const handle = {
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!files.has(name) && !options?.create) {
          throw new DOMException("Not found", "NotFoundError");
        }
        if (!files.has(name)) {
          files.set(name, new Blob());
        }
        return {
          async getFile() {
            return new File([files.get(name) ?? new Blob()], name);
          },
          async createWritable() {
            let pending = new Blob();
            return {
              async write(data: Blob) {
                pending = data;
              },
              async close() {
                if (name === "recovered.jpg" && failCanonicalOnce) {
                  failCanonicalOnce = false;
                  files.set(name, new Blob(["partial"]));
                  throw new Error("browser stopped during commit");
                }
                files.set(name, pending);
              },
              async abort() {
                // The test deliberately leaves the partial canonical file behind.
              }
            };
          }
        };
      },
      async removeEntry(name: string) {
        files.delete(name);
      }
    } satisfies WritableDirectory;

    await expect(
      saveBlobWithoutClobbering(new Blob(["complete"]), handle, "recovered.jpg", () => "next")
    ).rejects.toThrow("browser stopped during commit");

    const result = await saveBlobWithoutClobbering(
      new Blob(["complete"]),
      handle,
      "recovered.jpg",
      () => "next"
    );
    expect(result).toEqual({ fileName: "recovered.jpg", skipped: false });
    expect(await files.get("recovered.jpg")?.text()).toBe("complete");
    expect([...files.keys()]).toEqual(["recovered.jpg"]);
  });
});

/** An in-memory stand-in for the archive folder the downloader writes through. */
interface MemoryDirectory {
  files: Map<string, Blob>;
  handle: WritableDirectory;
}

function createMemoryDirectory(initialFiles: Record<string, Blob>): MemoryDirectory {
  const files = new Map(Object.entries(initialFiles));
  const handle = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) {
        throw new DOMException("Not found", "NotFoundError");
      }
      if (!files.has(name)) {
        files.set(name, new Blob());
      }

      return {
        async getFile() {
          const blob = files.get(name) ?? new Blob();
          return new File([blob], name);
        },
        async createWritable() {
          let pending = new Blob();
          return {
            async write(data: Blob) {
              pending = data;
            },
            async close() {
              files.set(name, pending);
            },
            async abort() {
              // Leave the partial write uncommitted.
            }
          };
        }
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    }
  } satisfies WritableDirectory;

  return { files, handle };
}
