import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { DirectoryEntry, ScanArchiveOperations } from "./scan.js";
import { scanArchive } from "./scan.js";

function entry(name: string, type: "directory" | "file" | "other" = "file"): DirectoryEntry {
  return {
    name,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
  };
}

function delayedStream(content: string, delay: number, onDestroy?: () => void): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (sent) {
        return;
      }
      sent = true;
      setTimeout(() => {
        this.push(Buffer.from(content));
        this.push(null);
      }, delay);
    },
    destroy(error, callback) {
      onDestroy?.();
      callback(error);
    },
  });
}

describe("scanArchive", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("skips OS metadata files and directories", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "media-index-scan-"));
    const macMetadataDir = path.join(tempDir, "__MACOSX");
    const photosDir = path.join(tempDir, "photos");

    await mkdir(macMetadataDir, { recursive: true });
    await mkdir(photosDir, { recursive: true });
    await writeFile(path.join(tempDir, ".DS_Store"), "metadata");
    await writeFile(path.join(tempDir, "Thumbs.db"), "metadata");
    await writeFile(path.join(macMetadataDir, "._photo.jpg"), "metadata");
    await writeFile(path.join(photosDir, "cover.jpg"), "image");

    const scan = await scanArchive({ sourceRoot: tempDir });

    expect(scan.items.map((item) => item.path)).toEqual(["photos/cover.jpg"]);
    expect(scan.skippedEntries).toEqual([
      { path: ".DS_Store", reason: "system-file" },
      { path: "Thumbs.db", reason: "system-file" },
    ]);
  });

  it("skips unsupported extensions while indexing valid media", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "media-index-scan-"));
    const photosDir = path.join(tempDir, "photos");

    await mkdir(photosDir, { recursive: true });
    await writeFile(path.join(tempDir, "notes.txt"), "notes");
    await writeFile(path.join(tempDir, "archive.zip"), "zip");
    await writeFile(path.join(photosDir, "cover.jpg"), "image");

    const scan = await scanArchive({ sourceRoot: tempDir });

    expect(scan.items.map((item) => item.path)).toEqual(["photos/cover.jpg"]);
    expect(scan.skippedEntries).toEqual([
      { path: "archive.zip", reason: "unsupported-extension" },
      { path: "notes.txt", reason: "unsupported-extension" },
    ]);
  });

  it("stops scanning when aborted", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "media-index-scan-"));
    const photosDir = path.join(tempDir, "photos");

    await mkdir(photosDir, { recursive: true });
    await writeFile(path.join(photosDir, "cover.jpg"), "image");

    const controller = new AbortController();
    controller.abort();

    await expect(
      scanArchive({
        signal: controller.signal,
        sourceRoot: tempDir,
      }),
    ).rejects.toThrow();
  });

  it("returns items and skipped entries in logical path order despite delayed discovery", async () => {
    const directories = new Map<string, DirectoryEntry[]>([
      ["/archive", [entry("z", "directory"), entry("a", "directory")]],
      ["/archive/a", [entry("later.txt"), entry("first.jpg")]],
      ["/archive/z", [entry("last.png"), entry("socket", "other")]],
    ]);
    const operations: ScanArchiveOperations = {
      createReadStream: () => Readable.from([]),
      readdir: async (directoryPath) => {
        await new Promise((resolve) => setTimeout(resolve, directoryPath.endsWith("a") ? 20 : 1));
        return directories.get(directoryPath) ?? [];
      },
      stat: async () => ({ mtimeMs: 1, size: 1 }),
    };

    const scans = await Promise.all(
      Array.from({ length: 3 }, () =>
        scanArchive({ directoryConcurrency: 2, operations, sourceRoot: "/archive" }),
      ),
    );

    for (const scan of scans) {
      expect(scan.items.map((item) => item.path)).toEqual(["a/first.jpg", "z/last.png"]);
      expect(scan.skippedEntries).toEqual([
        { path: "a/later.txt", reason: "unsupported-extension" },
        { path: "z/socket", reason: "not-a-regular-file" },
      ]);
    }
  });

  it("bounds directory reads and stops dequeuing after abort", async () => {
    const controller = new AbortController();
    let active = 0;
    let peak = 0;
    const readDirectories: string[] = [];
    const operations: ScanArchiveOperations = {
      createReadStream: () => Readable.from([]),
      readdir: async (directoryPath) => {
        readDirectories.push(directoryPath);
        active += 1;
        peak = Math.max(peak, active);
        if (directoryPath === "/archive/a") {
          controller.abort(new Error("cancelled"));
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return directoryPath === "/archive"
          ? [entry("a", "directory"), entry("b", "directory"), entry("c", "directory")]
          : [];
      },
      stat: async () => ({ mtimeMs: 1, size: 1 }),
    };

    await expect(
      scanArchive({ directoryConcurrency: 1, operations, signal: controller.signal, sourceRoot: "/archive" }),
    ).rejects.toThrow("cancelled");
    expect(peak).toBe(1);
    expect(readDirectories).toEqual(["/archive", "/archive/a"]);
  });

  it("bounds stat and hash work, preserves hashes, and reports the hashing file path", async () => {
    let active = 0;
    let peak = 0;
    const progressPaths: string[] = [];
    const operations: ScanArchiveOperations = {
      createReadStream: (filePath) => {
        active += 1;
        peak = Math.max(peak, active);
        return delayedStream(filePath, 5, () => {
          active -= 1;
        });
      },
      readdir: async () => [entry("c.jpg"), entry("a.jpg"), entry("b.jpg")],
      stat: async (filePath) => ({ mtimeMs: 1, size: filePath.length }),
    };

    const scan = await scanArchive({
      fileConcurrency: 2,
      hashFiles: true,
      onProgress: (progress) => {
        if (progress.stage === "hashing") {
          progressPaths.push(progress.path);
          expect(progress.fileSize).toBe(path.join("/archive", progress.path).length);
        }
      },
      operations,
      sourceRoot: "/archive",
    });

    expect(peak).toBe(2);
    expect(scan.items.map((item) => item.path)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(scan.items.map((item) => item.sha256)).toEqual([
      "414e9d4114ffe3eb17fbc610198a2a94351aef2f4cb4267d06315af6d2b7d690",
      "5a9d754ef887314ad94d446e5d3c70e305fb190f146b52a1f6c379586461e46f",
      "37f764119f4a0788e25e536c5a90d24a1dd96b25a642dd5638a42760f1db396e",
    ]);
    expect(progressPaths.sort()).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("destroys an active hash stream when aborted", async () => {
    const controller = new AbortController();
    let destroyed = false;
    const operations: ScanArchiveOperations = {
      createReadStream: () => delayedStream("image", 50, () => {
        destroyed = true;
      }),
      readdir: async () => [entry("cover.jpg")],
      stat: async () => ({ mtimeMs: 1, size: 5 }),
    };

    const scan = scanArchive({ hashFiles: true, operations, signal: controller.signal, sourceRoot: "/archive" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("cancelled"));

    await expect(scan).rejects.toThrow("cancelled");
    expect(destroyed).toBe(true);
  });

  it("propagates read errors and handles empty trees", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "media-index-scan-"));
    await expect(scanArchive({ sourceRoot: tempDir })).resolves.toMatchObject({
      items: [],
      skippedEntries: [],
    });

    await expect(scanArchive({ sourceRoot: path.join(tempDir, "missing") })).rejects.toThrow();
  });
});
