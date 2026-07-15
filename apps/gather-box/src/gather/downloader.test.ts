import { afterEach, describe, expect, it, vi } from "vitest";
import { addFileNameSuffix, downloadImages, saveBlobWithoutClobbering } from "./downloader";

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
});

function createMemoryDirectory(initialFiles: Record<string, Blob>): {
  files: Map<string, Blob>;
  handle: FileSystemDirectoryHandle;
} {
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
            async write(data: FileSystemWriteChunkType) {
              pending = data instanceof Blob ? data : new Blob([data as BlobPart]);
            },
            async close() {
              files.set(name, pending);
            }
          };
        }
      };
    }
  } as unknown as FileSystemDirectoryHandle;

  return { files, handle };
}
