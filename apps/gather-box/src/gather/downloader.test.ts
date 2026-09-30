import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadImages,
  runPool,
  saveBlobWithoutClobbering,
  type WritableDirectory,
  type WritableFile,
  type WritableFileStream
} from "./downloader";

/**
 * An in-memory folder with File System Access semantics: a write lands only when its stream
 * closes, and a missing entry rejects with NotFoundError. Two switches stand in for a browser
 * that stops mid-save.
 */
class MemoryDirectory implements WritableDirectory {
  readonly files = new Map<string, Blob>();
  /** Writes to this name open the file but never close, as when Chrome quits mid-write. */
  interruptWritesTo: string | null = null;
  /** Commit markers cannot be removed, as when Chrome quits right after a write lands. */
  failMarkerRemoval = false;

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFile> {
    if (!this.files.has(name)) {
      if (!options?.create) {
        throw new DOMException(`${name} not found`, "NotFoundError");
      }

      this.files.set(name, new Blob([]));
    }

    return {
      getFile: async () => new File([this.files.get(name) ?? new Blob([])], name),
      createWritable: async (): Promise<WritableFileStream> => {
        let pending = new Blob([]);

        return {
          write: async (data) => {
            pending = data;
          },
          close: async () => {
            if (this.interruptWritesTo === name) {
              throw new Error("browser stopped");
            }

            this.files.set(name, pending);
          }
        };
      }
    };
  }

  async removeEntry(name: string): Promise<void> {
    if (this.failMarkerRemoval && isMarker(name)) {
      throw new Error("browser stopped");
    }

    if (!this.files.delete(name)) {
      throw new DOMException(`${name} not found`, "NotFoundError");
    }
  }

  async text(name: string): Promise<string | undefined> {
    return this.files.get(name)?.text();
  }

  mediaNames(): string[] {
    return [...this.files.keys()].filter((name) => !isMarker(name)).sort();
  }

  markerNames(): string[] {
    return [...this.files.keys()].filter(isMarker);
  }
}

function isMarker(name: string): boolean {
  return name.startsWith(".gather-box-commit-");
}

const blob = (text: string) => new Blob([text]);

describe("collision-safe saving", () => {
  it("never replaces a finished original whose commit marker was left behind", async () => {
    const directory = new MemoryDirectory();
    directory.failMarkerRemoval = true;
    await expect(saveBlobWithoutClobbering(blob("original A"), directory, "same.jpg")).rejects.toThrow(
      "browser stopped"
    );
    directory.failMarkerRemoval = false;
    expect(await directory.text("same.jpg")).toBe("original A");
    expect(directory.markerNames()).toHaveLength(1);

    const saved = await saveBlobWithoutClobbering(blob("different B"), directory, "same.jpg");

    expect(saved).toMatchObject({ skipped: false });
    expect(saved.fileName).not.toBe("same.jpg");
    expect(await directory.text("same.jpg")).toBe("original A");
    expect(await directory.text(saved.fileName)).toBe("different B");
    expect(directory.markerNames()).toHaveLength(0);
  });

  it("never replaces an archive edit made after a commit marker was left behind", async () => {
    const directory = new MemoryDirectory();
    directory.failMarkerRemoval = true;
    await expect(saveBlobWithoutClobbering(blob("download A"), directory, "same.jpg")).rejects.toThrow(
      "browser stopped"
    );
    directory.failMarkerRemoval = false;
    directory.files.set("same.jpg", blob("archive edit B"));

    const replay = await saveBlobWithoutClobbering(blob("download A"), directory, "same.jpg");

    expect(replay.fileName).not.toBe("same.jpg");
    expect(await directory.text("same.jpg")).toBe("archive edit B");
    expect(await directory.text(replay.fileName)).toBe("download A");
    expect(directory.markerNames()).toHaveLength(0);
  });

  it("repairs an interrupted write when the same content is replayed", async () => {
    const directory = new MemoryDirectory();
    directory.interruptWritesTo = "page.jpg";
    await expect(saveBlobWithoutClobbering(blob("page"), directory, "page.jpg")).rejects.toThrow(
      "browser stopped"
    );
    directory.interruptWritesTo = null;
    expect(await directory.text("page.jpg")).toBe("");

    await expect(saveBlobWithoutClobbering(blob("page"), directory, "page.jpg")).resolves.toEqual({
      fileName: "page.jpg",
      skipped: false
    });
    expect(await directory.text("page.jpg")).toBe("page");
    expect(directory.mediaNames()).toEqual(["page.jpg"]);
    expect(directory.markerNames()).toHaveLength(0);
  });

  it("leaves another item's interrupted write for that item to repair", async () => {
    const directory = new MemoryDirectory();
    directory.interruptWritesTo = "page.jpg";
    await expect(saveBlobWithoutClobbering(blob("first"), directory, "page.jpg")).rejects.toThrow(
      "browser stopped"
    );
    directory.interruptWritesTo = null;

    const saved = await saveBlobWithoutClobbering(blob("second"), directory, "page.jpg");

    expect(saved.fileName).not.toBe("page.jpg");
    expect(await directory.text(saved.fileName)).toBe("second");

    await expect(saveBlobWithoutClobbering(blob("first"), directory, "page.jpg")).resolves.toEqual({
      fileName: "page.jpg",
      skipped: false
    });
    expect(await directory.text("page.jpg")).toBe("first");
    expect(directory.markerNames()).toHaveLength(0);
  });

  it("skips a replayed collision instead of writing another suffixed copy", async () => {
    const directory = new MemoryDirectory();
    await saveBlobWithoutClobbering(blob("A"), directory, "same.jpg");

    const first = await saveBlobWithoutClobbering(blob("B"), directory, "same.jpg");
    const replay = await saveBlobWithoutClobbering(blob("B"), directory, "same.jpg");

    expect(first).toMatchObject({ skipped: false });
    expect(first.fileName).toMatch(/^same_[a-z0-9]{4}\.jpg$/);
    expect(replay).toEqual({ fileName: first.fileName, skipped: true });
    expect(directory.mediaNames()).toEqual(["same.jpg", first.fileName].sort());
  });

  it("moves past a suffixed name that holds other content, then reuses the new name", async () => {
    const directory = new MemoryDirectory();
    await saveBlobWithoutClobbering(blob("A"), directory, "same.jpg");
    const { fileName: suffixed } = await saveBlobWithoutClobbering(blob("B"), directory, "same.jpg");
    directory.files.set(suffixed, blob("unrelated C"));

    const moved = await saveBlobWithoutClobbering(blob("B"), directory, "same.jpg");
    const replay = await saveBlobWithoutClobbering(blob("B"), directory, "same.jpg");

    expect(moved.fileName).not.toBe(suffixed);
    expect(await directory.text(suffixed)).toBe("unrelated C");
    expect(await directory.text(moved.fileName)).toBe("B");
    expect(replay).toEqual({ fileName: moved.fileName, skipped: true });
  });
});

describe("download worker pool", () => {
  it("waits for every active worker to unwind before reporting a failure", async () => {
    let releaseWrite: () => void = () => undefined;

    const writing = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    const started: number[] = [];
    let writeFinished = false;

    const pool = runPool([0, 1, 2, 3], 2, async (item) => {
      started.push(item);

      if (item === 0) {
        await writing;
        writeFinished = true;

        return;
      }

      throw new DOMException("The operation was aborted.", "AbortError");
    });

    let settled = false;

    void pool.catch(() => undefined).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    releaseWrite();
    await expect(pool).rejects.toThrow("aborted");
    expect(writeFinished).toBe(true);
    expect(started).toEqual([0, 1]);
  });
});

describe("downloading", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const callbacks = { onStart: () => undefined, onProgress: () => undefined, onSaved: () => undefined };

  it("fails an item whose server answers with a web page instead of the file", async () => {
    const directory = new MemoryDirectory();
    vi.stubGlobal("fetch", async () =>
      new Response("<!DOCTYPE html><html><body>Sign in</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      })
    );

    const summary = await downloadImages(
      [
        {
          pageNumber: 1,
          thumbnailUrl: null,
          originalUrl: "https://archiveofourown.org/downloads/1/Story.pdf",
          fileName: "Author-Story.pdf"
        }
      ],
      directory,
      callbacks
    );

    expect(summary).toMatchObject({ saved: 0, failed: 1 });
    expect(summary.failedItems[0]?.originalUrl).toBe("https://archiveofourown.org/downloads/1/Story.pdf");
    expect(directory.mediaNames()).toEqual([]);
  });

  it("fails an empty body and a web page served with a generic type", async () => {
    const directory = new MemoryDirectory();
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("empty.jpg")
        ? new Response(new Blob([]), { status: 200 })
        : new Response("\n  <html><head><title>Error</title></head></html>", {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" }
          })
    );

    const summary = await downloadImages(
      [
        { pageNumber: 1, thumbnailUrl: null, originalUrl: "https://cdn.test/empty.jpg", fileName: "empty.jpg" },
        { pageNumber: 2, thumbnailUrl: null, originalUrl: "https://cdn.test/page.png", fileName: "page.png" }
      ],
      directory,
      callbacks
    );

    expect(summary).toMatchObject({ saved: 0, failed: 2 });
    expect(directory.mediaNames()).toEqual([]);
  });

  it("saves a real file", async () => {
    const directory = new MemoryDirectory();
    vi.stubGlobal("fetch", async () =>
      new Response(new Blob(["%PDF-1.7"]), { status: 200, headers: { "Content-Type": "application/pdf" } })
    );

    const summary = await downloadImages(
      [{ pageNumber: 1, thumbnailUrl: null, originalUrl: "https://cdn.test/a.pdf", fileName: "a.pdf" }],
      directory,
      callbacks
    );

    expect(summary).toMatchObject({ saved: 1, failed: 0 });
    expect(await directory.text("a.pdf")).toBe("%PDF-1.7");
  });
});
