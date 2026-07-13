import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyHashCache,
  lookupHashCache,
  updateHashCache,
} from "./hash-cache.js";

describe("hash-cache", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("returns cached sha256 when mtime and size match", () => {
    const cache = createEmptyHashCache();
    updateHashCache(cache, "photos/a.jpg", 100, 42, "abc123");

    expect(lookupHashCache(cache, "photos/a.jpg", 100, 42)).toBe("abc123");
    expect(lookupHashCache(cache, "photos/a.jpg", 101, 42)).toBeUndefined();
    expect(lookupHashCache(cache, "photos/a.jpg", 100, 43)).toBeUndefined();
  });

  it("persists and reloads from disk", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "hash-cache-"));
    const cachePath = path.join(tempDir, "cache.json");
    const cache = createEmptyHashCache();
    updateHashCache(cache, "photos/a.jpg", 100, 42, "abc123");
    const { writeHashCache, readHashCache } = await import("./hash-cache.js");
    await writeHashCache(cachePath, cache);

    const loaded = await readHashCache(cachePath);
    expect(lookupHashCache(loaded, "photos/a.jpg", 100, 42)).toBe("abc123");
  });
});

describe("scanArchiveSelectiveHash", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("hashes only new files and size mismatches", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "selective-hash-"));
    const photosDir = path.join(tempDir, "photos");
    await mkdir(photosDir, { recursive: true });

    const unchanged = Buffer.from("unchanged");
    const changed = Buffer.from("changed");
    await writeFile(path.join(photosDir, "keep.jpg"), unchanged);
    await writeFile(path.join(photosDir, "new.jpg"), Buffer.from("new"));
    await writeFile(path.join(photosDir, "update.jpg"), changed);

    const { scanArchiveSelectiveHash } = await import("./scan-optimized.js");
    const result = await scanArchiveSelectiveHash({
      remoteEntries: [
        {
          path: "photos/keep.jpg",
          sha256: createHash("sha256").update(unchanged).digest("hex"),
          size: unchanged.length,
        },
        {
          path: "photos/update.jpg",
          sha256: createHash("sha256").update(Buffer.from("old")).digest("hex"),
          size: 3,
        },
      ],
      sourceRoot: tempDir,
    });

    expect(result.hashed).toBe(2);
    expect(result.skippedHash).toBe(1);
    expect(result.items.find((item) => item.path === "photos/keep.jpg")?.sha256).toBeUndefined();
    expect(result.items.find((item) => item.path === "photos/new.jpg")?.sha256).toBeDefined();
    expect(result.items.find((item) => item.path === "photos/update.jpg")?.sha256).toBeDefined();
  });
});
