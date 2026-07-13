import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planSync } from "./plan-sync.js";

describe("planSync incremental hashing", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("uses selective hashing and cache on repeat push planning", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "plan-sync-"));
    const photosDir = path.join(tempDir, "photos");
    await mkdir(photosDir, { recursive: true });

    const unchanged = Buffer.from("unchanged");
    const changed = Buffer.from("changed-payload");
    await writeFile(path.join(photosDir, "keep.jpg"), unchanged);
    await writeFile(path.join(photosDir, "update.jpg"), changed);

    const remoteSnapshotPath = path.join(tempDir, "remote.json");
    await writeFile(
      remoteSnapshotPath,
      JSON.stringify([
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
      ]),
    );

    const cachePath = path.join(tempDir, ".latch-works", "hash-cache.json");
    const firstPlan = await planSync({
      hashCachePath: cachePath,
      hashFiles: true,
      remoteSnapshotPath,
      sourceRoot: tempDir,
    });

    expect(firstPlan.counts.upload).toBe(0);
    expect(firstPlan.counts.update).toBe(1);
    expect(firstPlan.counts.keep).toBe(1);
    expect(firstPlan.items.find((item) => item.path === "photos/keep.jpg")?.local?.sha256).toBeUndefined();

    const cacheRaw = await readFile(cachePath, "utf8");
    expect(cacheRaw).toContain("photos/update.jpg");

    const secondPlan = await planSync({
      hashCachePath: cachePath,
      hashFiles: true,
      remoteSnapshotPath,
      sourceRoot: tempDir,
    });

    expect(secondPlan.counts).toEqual(firstPlan.counts);
    expect(secondPlan.items.find((item) => item.path === "photos/update.jpg")?.local?.sha256).toBe(
      createHash("sha256").update(changed).digest("hex"),
    );
  });

  it("uses hash cache without remote snapshot", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "plan-sync-cache-"));
    const photosDir = path.join(tempDir, "photos");
    await mkdir(photosDir, { recursive: true });
    await writeFile(path.join(photosDir, "solo.jpg"), Buffer.from("solo"));

    const cachePath = path.join(tempDir, ".latch-works", "hash-cache.json");
    const firstPlan = await planSync({
      hashCachePath: cachePath,
      hashFiles: true,
      sourceRoot: tempDir,
    });

    expect(firstPlan.counts.upload).toBe(1);
    expect(firstPlan.items[0]?.local?.sha256).toBeDefined();

    const secondPlan = await planSync({
      hashCachePath: cachePath,
      hashFiles: true,
      sourceRoot: tempDir,
    });

    expect(secondPlan.items[0]?.local?.sha256).toBe(firstPlan.items[0]?.local?.sha256);
  });
});
