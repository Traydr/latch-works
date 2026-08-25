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

  it("destroys an active hash stream when aborted", async () => {
    const controller = new AbortController();
    let destroyed = false;
    const operations: ScanArchiveOperations = {
      createReadStream: () =>
        delayedStream("image", 50, () => {
          destroyed = true;
        }),
      readdir: async () => [entry("cover.jpg")],
      stat: async () => ({ mtimeMs: 1, size: 5 }),
    };

    const scan = scanArchive({
      hashFiles: true,
      operations,
      signal: controller.signal,
      sourceRoot: "/archive",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("cancelled"));

    await expect(scan).rejects.toThrow("cancelled");
    expect(destroyed).toBe(true);
  });

  it("rejects a file whose fingerprint changes while it is being hashed", async () => {
    let statCalls = 0;
    const operations: ScanArchiveOperations = {
      createReadStream: () => Readable.from([Buffer.from("image")]),
      readdir: async () => [entry("cover.jpg")],
      stat: async () => {
        statCalls += 1;
        return { ctimeMs: statCalls, mtimeMs: statCalls, size: 5 };
      },
    };

    await expect(
      scanArchive({ hashFiles: true, operations, sourceRoot: "/archive" }),
    ).rejects.toThrow("File changed while hashing");
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
