import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRemoteSnapshot } from "./remote-snapshot.js";

describe("readRemoteSnapshot", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true });
      tempDir = undefined;
    }
  });

  async function writeSnapshot(contents: string): Promise<string> {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-remote-snapshot-"));
    const filePath = path.join(tempDir, "snapshot.json");
    await writeFile(filePath, contents, "utf-8");
    return filePath;
  }

  it("keeps path, size, and a string sha256 and drops any other sha256", async () => {
    const filePath = await writeSnapshot(
      JSON.stringify([
        { path: "photos/a.jpg", sha256: "a".repeat(64), size: 4 },
        { extra: "ignored", path: "photos/b.jpg", sha256: 7, size: 5 },
      ]),
    );

    await expect(readRemoteSnapshot(filePath)).resolves.toEqual([
      { path: "photos/a.jpg", sha256: "a".repeat(64), size: 4 },
      { path: "photos/b.jpg", size: 5 },
    ]);
  });

  it("rejects a snapshot that is not a JSON array", async () => {
    const filePath = await writeSnapshot(JSON.stringify({ entries: [] }));

    await expect(readRemoteSnapshot(filePath)).rejects.toThrow(
      "Remote snapshot must be a JSON array.",
    );
  });

  it("rejects an entry without a path or size", async () => {
    const filePath = await writeSnapshot(JSON.stringify([{ path: "photos/a.jpg" }]));

    await expect(readRemoteSnapshot(filePath)).rejects.toThrow(
      "Remote snapshot entries must include path and size.",
    );
  });
});
