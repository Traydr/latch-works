import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanArchive } from "./scan.js";

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
});
