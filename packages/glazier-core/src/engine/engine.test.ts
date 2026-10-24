import {
  appendFile,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scanArchive } from "@latch-works/media-index";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FileFilter, FileFlag, FileRow, Root } from "../contract.js";
import { type EngineHarness, openEngine, testPicture } from "../test-support/engine-harness.js";

let archive: string;

let dataDir: string;

let harness: EngineHarness;

let root: Root;

/** 2021-03-04T05:06:07Z: an mtime old enough that a conversion that drops it would show. */
const ORIGINAL_MTIME = new Date("2021-03-04T05:06:07Z");

/** The copy is newer than the original, as a copy made later would be. */
const COPIED_MTIME = new Date("2022-01-01T00:00:00Z");

async function filesNamed(name: string): Promise<FileRow[]> {
  const page = await harness.call("listFiles", {
    rootId: root.id,
    search: name,
    kinds: [],
    formats: [],
    audioStates: [],
    flags: [],
    dir: null,
    sort: "path",
    descending: false,
    offset: 0,
    limit: 50,
  });

  return page.rows.filter((row) => row.name === name);
}

async function onlyFile(name: string): Promise<FileRow> {
  const [row] = await filesNamed(name);

  if (!row) {
    throw new Error(`${name} is not in the catalog`);
  }

  return row;
}

async function holdingContents(): Promise<string[]> {
  const holding = path.join(archive, ".glazier-holding");
  const found: string[] = [];

  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else {
        found.push(path.relative(holding, full).split(path.sep).slice(1).join("/"));
      }
    }
  };

  await walk(holding);

  return found.sort();
}

beforeAll(async () => {
  archive = await mkdtemp(path.join(os.tmpdir(), "glazier-archive-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "glazier-data-"));

  await mkdir(path.join(archive, "photos"));
  await mkdir(path.join(archive, "dup"));
  await mkdir(path.join(archive, "empty"));

  const photo = path.join(archive, "photos", "photo.png");
  await testPicture(1).png().toFile(photo);
  await utimes(photo, ORIGINAL_MTIME, ORIGINAL_MTIME);
  await copyFile(photo, path.join(archive, "dup", "photo-copy.png"));
  await utimes(path.join(archive, "dup", "photo-copy.png"), COPIED_MTIME, COPIED_MTIME);
  await link(photo, path.join(archive, "photos", "photo-link.png"));
  await sharp(photo)
    .resize(320, 240)
    .jpeg({ quality: 60 })
    .toFile(path.join(archive, "photos", "small.jpg"));
  await testPicture(4).png().toFile(path.join(archive, "misnamed.jpg"));
  await writeFile(path.join(archive, "notes.txt"), "not media");
  await writeFile(path.join(archive, ".DS_Store"), "junk");
  await symlink(path.join(archive, "photos"), path.join(archive, "photos-link"));

  harness = await openEngine(dataDir);
  root = await harness.call("addRoot", { path: archive });
  await harness.idle();
});

afterAll(async () => {
  await harness.idle();
  harness.engine.close();
  await rm(archive, { force: true, recursive: true });
  await rm(dataDir, { force: true, recursive: true });
});

/** Every file of the root with any of these flags, or every file for none. */
function filterBy(flags: FileFlag[]): FileFilter {
  return { rootId: root.id, search: "", kinds: [], formats: [], audioStates: [], flags, dir: null };
}

describe("glazier engine", () => {
  it("inventories the root without following symlinks and lists what Tidy has to do", async () => {
    const tidy = await harness.call("tidy", { rootId: root.id });

    // photo, its copy, its hard link, the JPEG, the misnamed PNG, the text file and .DS_Store.
    expect(tidy.files).toBe(7);
    expect(tidy.cleanup).toEqual({ junk: 1, emptyFolders: 1, extensions: 1 });
    expect(tidy.attention).toEqual([{ kind: "unsupported", count: 1, bytes: 9 }]);
    expect(tidy.analysis).toMatchObject({ fingerprinted: 5, fingerprintable: 5 });
    expect((await onlyFile("misnamed.jpg")).format).toBe("png");
    expect((await onlyFile("photo.png")).width).toBe(640);
  });

  it("puts byte-identical copies and a resized version in one set, hard links freeing nothing", async () => {
    const page = await harness.call("duplicateSets", {
      rootId: root.id,
      level: "balanced",
      scope: "all",
      dismissed: false,
      offset: 0,
      limit: 10,
    });

    const [set] = page.sets;
    const keep = await onlyFile("photo.png");
    const link = await onlyFile("photo-link.png");
    const copy = await onlyFile("photo-copy.png");
    const small = await onlyFile("small.jpg");

    expect(page.counts).toEqual({ exact: 0, similar: 1, dismissed: 0 });
    expect(set?.kind).toBe("similar");
    expect(set?.versions.map((version) => version.files.map((file) => file.name))).toEqual([
      ["photo.png", "photo-link.png", "photo-copy.png"],
      ["small.jpg"],
    ]);
    expect(set?.keep).toEqual([keep.id]);
    expect(set?.keepReason).toBe("more-pixels");
    expect(set?.hardLinkedIds).toHaveLength(2);
    expect(set?.reclaimableBytes).toBe(copy.size + small.size);
    expect(set?.key).toBe(`similar:${Math.min(keep.id, link.id, copy.id, small.id)}`);

    const tidy = await harness.call("tidy", { rootId: root.id });
    expect(tidy.duplicates.similar).toEqual({
      sets: 1,
      extraCopies: 2,
      reclaimableBytes: copy.size + small.size,
    });
  });

  it("matches a file with any of the chosen flags", async () => {
    const page = await harness.call("listFiles", {
      ...filterBy(["junk", "extension-mismatch"]),
      sort: "name",
      descending: false,
      offset: 0,
      limit: 50,
    });

    expect(page.rows.map((row) => row.name)).toEqual([".DS_Store", "misnamed.jpg"]);
    expect(page.total).toBe(2);
  });

  it("leaves identical copies out of the Convert step until they are resolved", async () => {
    const summary = await harness.call("optimizeSummary", { rootId: root.id });

    expect(summary.skipped).toContainEqual({
      reason: "Identical copies (resolve duplicates first)",
      files: 3,
    });

    const convertible = await harness.call("listFileIds", filterBy(["convertible"]));

    const names = await harness.call("getFiles", { ids: convertible.ids });
    expect(names.map((row) => row.relPath)).toEqual(["misnamed.jpg", "photos/small.jpg"]);

    const facets = await harness.call("fileFacets", filterBy([]));
    expect(facets.flags.find((facet) => facet.value === "convertible")?.files).toBe(2);

    const selection = await harness.call("selectionSummary", { fileIds: convertible.ids });
    expect(selection.convertible.files).toBe(2);
    expect(selection.extensionMismatches).toBe(1);
  });

  it("moves a removed duplicate into holding, out of Lockstep's scan, and undo brings it back", async () => {
    const keep = await onlyFile("photo.png");
    const copy = await onlyFile("photo-copy.png");
    const link = await onlyFile("photo-link.png");

    const preview = await harness.call("previewPlan", {
      kind: "resolve-duplicates",
      groups: [{ keep: [keep.id], remove: [copy.id, link.id] }],
    });

    // The hard link shares the kept file's bytes, so holding it would free nothing.
    expect(preview.steps).toBe(1);
    expect(preview.bytesToHolding).toBe(copy.size);
    expect(preview.lockstep).toEqual({ removedPaths: 1, addedPaths: 0 });

    await harness.settle(await harness.call("applyPlan", { planId: preview.planId }));

    await expect(stat(path.join(archive, "dup", "photo-copy.png"))).rejects.toThrow();
    expect(await holdingContents()).toEqual(["dup/photo-copy.png"]);

    const lockstepView = await scanArchive({ sourceRoot: archive });
    expect(
      lockstepView.items.map((item) => item.path).filter((item) => item.includes("glazier")),
    ).toEqual([]);

    const holding = await harness.call("listHolding", { rootId: root.id, offset: 0, limit: 10 });
    expect(holding.items.map((item) => item.reason)).toEqual(["Duplicate of photos/photo.png"]);

    const plan = await harness.call("getPlan", { planId: preview.planId });
    expect(plan).toMatchObject({ title: "Resolved 1 duplicate set", count: 1, status: "applied" });
    expect(plan.held).toEqual({ files: 1, bytes: copy.size });

    const undo = await harness.call("undoPlan", { planId: preview.planId });
    expect(undo).toMatchObject({
      planId: preview.planId,
      label: "Undoing “Resolved 1 duplicate set”",
    });
    await harness.idle();

    expect((await stat(path.join(archive, "dup", "photo-copy.png"))).size).toBe(copy.size);
    expect(await holdingContents()).toEqual([]);
  });

  it("converts a still to AVIF in place of the original, keeping its date", async () => {
    const original = await onlyFile("photo.png");
    const copy = await onlyFile("photo-copy.png");

    // Identical copies wait for duplicate review, so the copy is resolved first.
    const resolved = await harness.call("perform", {
      kind: "resolve-duplicates",
      groups: [{ keep: [original.id], remove: [copy.id] }],
    });

    if (resolved.job === null) {
      throw new Error("The resolve did not start");
    }

    await harness.settle(resolved.job);

    const { preview, job } = await harness.call("perform", {
      kind: "optimize",
      rootId: root.id,
      categories: ["still-to-avif"],
      fileIds: [original.id],
    });

    expect(preview.bytesToHolding).toBe(original.size);
    expect(job?.label).toBe("Converting 1 file");

    if (job === null) {
      throw new Error("The conversion did not start");
    }

    await harness.settle(job);

    const converted = await stat(path.join(archive, "photos", "photo.avif"));
    expect(Math.trunc(converted.mtimeMs / 1000)).toBe(ORIGINAL_MTIME.getTime() / 1000);
    expect(converted.size).toBeLessThan(original.size);
    expect(await holdingContents()).toEqual(["dup/photo-copy.png", "photos/photo.png"]);

    const row = await onlyFile("photo.avif");
    expect(row.format).toBe("avif");
    expect([row.width, row.height]).toEqual([640, 480]);
    expect(await filesNamed("photo.png")).toEqual([]);
    expect(await harness.call("getPlan", { planId: preview.planId })).toMatchObject({
      title: "Converted 1 file",
      held: { files: 1, bytes: original.size },
    });

    await harness.idle();
  });

  it("skips a file that changed after the scan instead of acting on stale facts", async () => {
    const misnamed = await onlyFile("misnamed.jpg");
    const preview = await harness.call("previewPlan", { kind: "hold", fileIds: [misnamed.id] });

    await appendFile(path.join(archive, "misnamed.jpg"), "changed");
    await harness.settle(await harness.call("applyPlan", { planId: preview.planId }));

    const steps = await harness.call("planSteps", { planId: preview.planId, offset: 0, limit: 10 });
    expect(steps.steps.map((step) => step.status)).toEqual(["skipped"]);
    expect((await stat(path.join(archive, "misnamed.jpg"))).isFile()).toBe(true);
  });
});
