import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planSync } from "./plan-sync.js";
import type { LockstepRunEvent } from "./types.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("planSync hash modes", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true });
      tempDir = undefined;
    }
  });

  it("hashes only ambiguous equal-size entries on a cold remote-aware plan", async () => {
    const fixture = await createFixture();
    const events: LockstepRunEvent[] = [];

    const plan = await planSync(
      {
        hashCacheRoot: fixture.cacheRoot,
        hashMode: "remote-aware",
        remoteSnapshotPath: fixture.snapshotPath,
        sourceRoot: fixture.sourceRoot,
      },
      { onEvent: (event) => events.push(event) },
    );

    expect(plan.counts).toEqual({ delete: 0, keep: 2, update: 2, upload: 1 });
    expect(hashedPaths(events)).toEqual(new Set(["different.jpg", "same.jpg"]));
    expect(hashedBytes(events)).toBe(8);
    expect(plan.items.find((item) => item.path === "new.jpg")?.local?.sha256).toBeUndefined();
    expect(plan.items.find((item) => item.path === "resized.jpg")?.local?.sha256).toBeUndefined();
    expect(plan.items.find((item) => item.path === "without-hash.jpg")?.action).toBe("keep");
  });

  it("performs no media hashing on a warm unchanged remote-aware plan", async () => {
    const fixture = await createFixture();
    await planSync({
      hashCacheRoot: fixture.cacheRoot,
      hashMode: "remote-aware",
      remoteSnapshotPath: fixture.snapshotPath,
      sourceRoot: fixture.sourceRoot,
    });
    const events: LockstepRunEvent[] = [];

    const plan = await planSync(
      {
        hashCacheRoot: fixture.cacheRoot,
        hashMode: "remote-aware",
        remoteSnapshotPath: fixture.snapshotPath,
        sourceRoot: fixture.sourceRoot,
      },
      { onEvent: (event) => events.push(event) },
    );

    expect(plan.counts).toEqual({ delete: 0, keep: 2, update: 2, upload: 1 });
    expect(hashedPaths(events)).toEqual(new Set());
    expect(hashedBytes(events)).toBe(0);
  });

  it("keeps exhaustive hashing semantics while reusing warm cache entries", async () => {
    const fixture = await createFixture();
    const coldEvents: LockstepRunEvent[] = [];
    const cold = await planSync(
      {
        hashCacheRoot: fixture.cacheRoot,
        hashMode: "all",
        remoteSnapshotPath: fixture.snapshotPath,
        sourceRoot: fixture.sourceRoot,
      },
      { onEvent: (event) => coldEvents.push(event) },
    );
    const warmEvents: LockstepRunEvent[] = [];
    const warm = await planSync(
      {
        hashCacheRoot: fixture.cacheRoot,
        hashMode: "all",
        remoteSnapshotPath: fixture.snapshotPath,
        sourceRoot: fixture.sourceRoot,
      },
      { onEvent: (event) => warmEvents.push(event) },
    );

    expect(cold.items.filter((item) => item.local).every((item) => item.local?.sha256)).toBe(true);
    expect(hashedPaths(coldEvents).size).toBe(5);
    expect(hashedBytes(coldEvents)).toBe(28);
    expect(warm.items.filter((item) => item.local).every((item) => item.local?.sha256)).toBe(true);
    expect(hashedPaths(warmEvents)).toEqual(new Set());
  });

  it("continues with warnings when the cache cannot be read or written", async () => {
    const fixture = await createFixture();
    const blockedPath = path.join(fixture.root, "blocked");
    await writeFile(blockedPath, "file, not a directory", "utf-8");
    const events: LockstepRunEvent[] = [];

    const plan = await planSync(
      {
        hashCacheRoot: path.join(blockedPath, "cache"),
        hashMode: "remote-aware",
        remoteSnapshotPath: fixture.snapshotPath,
        sourceRoot: fixture.sourceRoot,
      },
      { onEvent: (event) => events.push(event) },
    );

    expect(plan.counts).toEqual({ delete: 0, keep: 2, update: 2, upload: 1 });
    expect(events.filter((event) => event.type === "status").map((event) => event.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Warning: Hash cache could not be read"),
        expect.stringContaining("Warning: hash cache could not be saved"),
      ]),
    );
  });

  it("hashes equal-size case-only path matches on remote-aware plans", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-plan-sync-case-"));
    const sourceRoot = path.join(tempDir, "archive");
    const nested = path.join(sourceRoot, "SFW");
    const cacheRoot = path.join(tempDir, "cache");
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "Photo.JPG"), "new!");
    await writeFile(
      snapshotPath,
      JSON.stringify([{ path: "sfw/photo.jpg", sha256: sha256("old!"), size: 4 }]),
      "utf-8",
    );
    const events: LockstepRunEvent[] = [];

    const plan = await planSync(
      {
        hashCacheRoot: cacheRoot,
        hashMode: "remote-aware",
        remoteSnapshotPath: snapshotPath,
        sourceRoot,
      },
      { onEvent: (event) => events.push(event) },
    );

    expect(hashedPaths(events)).toEqual(new Set(["SFW/Photo.JPG"]));
    expect(plan.counts).toEqual({ delete: 0, keep: 0, update: 1, upload: 0 });
    expect(plan.items[0]?.action).toBe("update");
    expect(plan.items[0]?.local?.sha256).toBe(sha256("new!"));
  });

  async function createFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "lockstep-plan-sync-"));
    tempDir = root;
    const sourceRoot = path.join(root, "archive");
    const cacheRoot = path.join(root, "cache");
    const snapshotPath = path.join(root, "snapshot.json");
    await mkdir(sourceRoot);

    const files = {
      "different.jpg": "new!",
      "new.jpg": "brand new",
      "resized.jpg": "larger",
      "same.jpg": "same",
      "without-hash.jpg": "plain",
    };
    await Promise.all(
      Object.entries(files).map(([filename, content]) =>
        writeFile(path.join(sourceRoot, filename), content),
      ),
    );
    await writeFile(
      snapshotPath,
      JSON.stringify([
        { path: "different.jpg", sha256: sha256("old!"), size: 4 },
        { path: "resized.jpg", sha256: sha256("old"), size: 3 },
        { path: "same.jpg", sha256: sha256("same"), size: 4 },
        { path: "without-hash.jpg", size: 5 },
      ]),
      "utf-8",
    );
    return { cacheRoot, root, snapshotPath, sourceRoot };
  }
});

function hashedPaths(events: readonly LockstepRunEvent[]): Set<string> {
  return new Set(
    events
      .filter((event) => event.type === "scan-progress" && event.progress.stage === "hashing")
      .map((event) => (event.type === "scan-progress" ? event.progress.path : undefined))
      .filter((pathname): pathname is string => pathname !== undefined),
  );
}

function hashedBytes(events: readonly LockstepRunEvent[]): number {
  const maximumByPath = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "scan-progress" || event.progress.stage !== "hashing") {
      continue;
    }
    maximumByPath.set(
      event.progress.path,
      Math.max(maximumByPath.get(event.progress.path) ?? 0, event.progress.bytesHashed),
    );
  }
  return [...maximumByPath.values()].reduce((sum, bytes) => sum + bytes, 0);
}
