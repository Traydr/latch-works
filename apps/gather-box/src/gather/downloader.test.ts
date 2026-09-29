import { describe, expect, it } from "vitest";
import {
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
});
