import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashCachePath, loadHashCache } from "./hash-cache.js";

describe("HashCache", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true });
      tempDir = undefined;
    }
  });

  it("persists and reloads valid per-source entries", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-hash-cache-"));
    const sourceRoot = path.join(tempDir, "archive");
    const loaded = await loadHashCache({ cacheRoot: tempDir, sourceRoot });
    const fingerprint = { ctimeMs: 8, mtimeMs: 7, size: 6 };
    const sha256 = "a".repeat(64);

    expect(loaded.warning).toBeUndefined();
    loaded.cache.set("photos/a.jpg", fingerprint, sha256);
    await loaded.cache.save();

    const reloaded = await loadHashCache({ cacheRoot: tempDir, sourceRoot });
    expect(reloaded.cache.get("photos/a.jpg", fingerprint)).toBe(sha256);
    expect(reloaded.cache.get("photos/a.jpg", { ...fingerprint, mtimeMs: 9 })).toBeUndefined();
    expect(JSON.parse(await readFile(reloaded.cache.filePath, "utf-8"))).toMatchObject({
      sourceRoot: path.resolve(sourceRoot),
      version: 1,
    });
  });

  it("warns and rebuilds malformed caches", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-hash-cache-"));
    const sourceRoot = path.join(tempDir, "archive");
    const filePath = hashCachePath(sourceRoot, tempDir);
    await writeFile(filePath, "not json", "utf-8");

    const loaded = await loadHashCache({ cacheRoot: tempDir, sourceRoot });

    expect(loaded.warning).toContain("will be rebuilt");
    expect(loaded.cache.get("photos/a.jpg", { mtimeMs: 1, size: 1 })).toBeUndefined();
  });

  it("prunes entries only when explicitly retained", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-hash-cache-"));
    const loaded = await loadHashCache({ cacheRoot: tempDir, sourceRoot: "/archive" });
    const fingerprint = { mtimeMs: 1, size: 1 };
    loaded.cache.set("keep.jpg", fingerprint, "a".repeat(64));
    loaded.cache.set("stale.jpg", fingerprint, "b".repeat(64));

    loaded.cache.retain(new Set(["keep.jpg"]));
    await loaded.cache.save();

    const reloaded = await loadHashCache({ cacheRoot: tempDir, sourceRoot: "/archive" });
    expect(reloaded.cache.get("keep.jpg", fingerprint)).toBe("a".repeat(64));
    expect(reloaded.cache.get("stale.jpg", fingerprint)).toBeUndefined();
  });
});
