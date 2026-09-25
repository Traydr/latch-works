import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRemoteSnapshot } from "./remote-snapshot.js";

const ENTRIES = [
  { path: "sfw/a.jpg", sha256: "abc", size: 10 },
  { path: "sfw/b.mp4", size: 20 },
];

describe("readRemoteSnapshot", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-snapshot-"));
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  async function writeSnapshot(contents: string): Promise<string> {
    const filePath = path.join(tempDir, "snapshot.json");
    await writeFile(filePath, contents, "utf-8");

    return filePath;
  }

  it("reads a bare array of entries", async () => {
    const filePath = await writeSnapshot(JSON.stringify(ENTRIES));

    await expect(readRemoteSnapshot(filePath)).resolves.toEqual(ENTRIES);
  });

  it("reads a saved GET /api/sync/snapshot response", async () => {
    const filePath = await writeSnapshot(JSON.stringify({ entries: ENTRIES, status: "database" }));

    await expect(readRemoteSnapshot(filePath)).resolves.toEqual(ENTRIES);
  });

  it("drops a null sha256 and extra fields", async () => {
    const filePath = await writeSnapshot(
      JSON.stringify({ entries: [{ extra: true, path: "a.jpg", sha256: null, size: 1 }] }),
    );

    await expect(readRemoteSnapshot(filePath)).resolves.toEqual([{ path: "a.jpg", size: 1 }]);
  });

  it("rejects an object without an entries array", async () => {
    const filePath = await writeSnapshot(JSON.stringify({ items: ENTRIES }));

    await expect(readRemoteSnapshot(filePath)).rejects.toThrow(
      "must be a JSON array of entries or an object with an entries array",
    );
  });

  it("rejects entries missing path or size", async () => {
    const filePath = await writeSnapshot(JSON.stringify({ entries: [{ path: "a.jpg" }] }));

    await expect(readRemoteSnapshot(filePath)).rejects.toThrow(
      "Remote snapshot entries must include path and size.",
    );
  });

  it("names the file when it is not JSON", async () => {
    const filePath = await writeSnapshot("not json");

    await expect(readRemoteSnapshot(filePath)).rejects.toThrow(
      `Remote snapshot ${filePath} is not valid JSON`,
    );
  });
});
