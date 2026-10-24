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

import type { FileRow, Root } from "../contract.js";
import { type EngineHarness, openEngine, testPicture } from "../test-support/engine-harness.js";

let archive: string;

let dataDir: string;

let harness: EngineHarness;

let root: Root;

/** 2021-03-04T05:06:07Z: an mtime old enough that a conversion that drops it would show. */
const ORIGINAL_MTIME = new Date("2021-03-04T05:06:07Z");

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
  harness.engine.close();
  await rm(archive, { force: true, recursive: true });
  await rm(dataDir, { force: true, recursive: true });
});

describe("glazier engine", () => {
  it("inventories the root without following symlinks and reports its findings", async () => {
    const overview = await harness.call("overview", { rootId: root.id });
    const findings = new Map(overview.findings.map((finding) => [finding.kind, finding.count]));

    // photo, its copy, its hard link, the JPEG, the misnamed PNG, the text file and .DS_Store.
    expect(overview.files).toBe(7);
    expect(findings.get("extension-mismatch")).toBe(1);
    expect(findings.get("junk")).toBe(1);
    expect(findings.get("empty-folder")).toBe(1);
    expect(findings.get("unsupported")).toBe(1);
    expect((await onlyFile("misnamed.jpg")).format).toBe("png");
    expect((await onlyFile("photo.png")).width).toBe(640);
  });

  it("finds exact duplicates and counts hard links as one file", async () => {
    const page = await harness.call("exactDuplicates", { rootId: root.id, offset: 0, limit: 10 });
    const [group] = page.groups;

    expect(page.total).toBe(1);
    expect(group?.members).toHaveLength(3);
    expect(group?.physicalCopies).toBe(2);
    expect(group?.reclaimableBytes).toBe(group?.size);
    expect(group?.hardLinkedIds).toHaveLength(2);
  });

  it("moves a removed duplicate into holding, out of Lockstep's scan, and undo brings it back", async () => {
    const keep = await onlyFile("photo.png");
    const copy = await onlyFile("photo-copy.png");

    const preview = await harness.call("previewPlan", {
      kind: "resolve-duplicates",
      groups: [{ keep: keep.id, remove: [copy.id] }],
    });

    expect(preview.steps).toBe(1);
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

    await harness.call("undoPlan", { planId: preview.planId });
    await harness.idle();

    expect((await stat(path.join(archive, "dup", "photo-copy.png"))).size).toBe(copy.size);
    expect(await holdingContents()).toEqual([]);
  });

  it("groups the resized JPEG with the picture it was made from", async () => {
    await harness.settle(await harness.call("analyzeSimilar", { rootId: root.id }));

    const page = await harness.call("similarDuplicates", {
      rootId: root.id,
      level: "balanced",
      offset: 0,
      limit: 10,
    });

    const names = page.groups.map((group) => group.members.map((member) => member.name).sort());

    expect(names).toEqual([["photo-copy.png", "photo-link.png", "photo.png", "small.jpg"]]);
    expect(page.groups[0]?.members[0]?.name).not.toBe("small.jpg");
  });

  it("converts a still to AVIF in place of the original, keeping its date", async () => {
    const original = await onlyFile("photo.png");

    const preview = await harness.call("previewPlan", {
      kind: "optimize",
      rootId: root.id,
      categories: ["still-to-avif"],
      fileIds: [original.id],
    });

    await harness.settle(await harness.call("applyPlan", { planId: preview.planId }));

    const converted = await stat(path.join(archive, "photos", "photo.avif"));
    expect(Math.trunc(converted.mtimeMs / 1000)).toBe(ORIGINAL_MTIME.getTime() / 1000);
    expect(converted.size).toBeLessThan(original.size);
    expect(await holdingContents()).toEqual(["photos/photo.png"]);

    const row = await onlyFile("photo.avif");
    expect(row.format).toBe("avif");
    expect([row.width, row.height]).toEqual([640, 480]);
    expect(await filesNamed("photo.png")).toEqual([]);
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
