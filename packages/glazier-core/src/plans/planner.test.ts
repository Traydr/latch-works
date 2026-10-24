import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Root } from "../contract.js";
import { type EngineHarness, openEngine, testPicture } from "../test-support/engine-harness.js";

let archive: string;

let dataDir: string;

let harness: EngineHarness;

let root: Root;

beforeAll(async () => {
  archive = await mkdtemp(path.join(os.tmpdir(), "glazier-planner-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "glazier-planner-data-"));

  await mkdir(path.join(archive, "empty"));
  await mkdir(path.join(archive, "only-junk"));
  await mkdir(path.join(archive, "photos"));
  await writeFile(path.join(archive, ".DS_Store"), "junk");
  await writeFile(path.join(archive, "only-junk", ".DS_Store"), "junk");
  // PNG bytes named .jpg, and AVIF bytes named .jpg: both get the extension their bytes have.
  await testPicture(7)
    .png()
    .toFile(path.join(archive, "photos", "pic.jpg"));
  await testPicture(8)
    .avif()
    .toFile(path.join(archive, "photos", "cover.jpg"));
  await testPicture(9)
    .png()
    .toFile(path.join(archive, "photos", "keep.png"));

  harness = await openEngine(dataDir);
  await harness.call("updateSettings", {
    preferredFolders: [],
    similarity: "balanced",
    reencodeQuality: "high",
    autoAnalyze: false,
  });
  root = await harness.call("addRoot", { path: archive });
  await harness.idle();
});

afterAll(async () => {
  await harness.idle();
  harness.engine.close();
  await rm(archive, { force: true, recursive: true });
  await rm(dataDir, { force: true, recursive: true });
});

describe("plans", () => {
  it("counts the folders an empty-folder plan removes, holding their junk first", async () => {
    const preview = await harness.call("previewPlan", {
      kind: "remove-empty-folders",
      rootId: root.id,
    });

    const steps = await harness.call("planSteps", { planId: preview.planId, offset: 0, limit: 10 });

    expect(
      steps.steps.map((step) => [step.action, path.relative(root.path, step.fromPath)]),
    ).toEqual([
      ["hold", path.join("only-junk", ".DS_Store")],
      ["remove-folder", "only-junk"],
      ["remove-folder", "empty"],
    ]);
    expect(await harness.call("getPlan", { planId: preview.planId })).toMatchObject({
      status: "draft",
      count: 2,
      title: "Removed 2 empty folders",
    });

    await harness.call("discardPlan", { planId: preview.planId });
  });

  it("cleans up junk, empty folders and extensions as one plan, each file once", async () => {
    expect((await harness.call("tidy", { rootId: root.id })).cleanup).toEqual({
      junk: 2,
      emptyFolders: 2,
      extensions: 2,
    });

    const { preview, job } = await harness.call("perform", { kind: "cleanup", rootId: root.id });
    const steps = await harness.call("planSteps", { planId: preview.planId, offset: 0, limit: 20 });

    expect(
      steps.steps.map((step) => [
        step.action,
        path.relative(root.path, step.fromPath),
        step.toPath === null ? null : path.basename(step.toPath),
      ]),
    ).toEqual([
      ["rename", path.join("photos", "cover.jpg"), "cover.avif"],
      ["rename", path.join("photos", "pic.jpg"), "pic.png"],
      ["hold", ".DS_Store", null],
      ["hold", path.join("only-junk", ".DS_Store"), null],
      ["remove-folder", "only-junk", null],
      ["remove-folder", "empty", null],
    ]);
    expect(job?.label).toBe("Cleaning up 6 items");

    if (job === null) {
      throw new Error("The clean-up did not start");
    }

    await harness.settle(job);

    expect(await harness.call("getPlan", { planId: preview.planId })).toMatchObject({
      title: "Cleaned up 6 items",
      done: 6,
      held: { files: 2, bytes: 8 },
    });
    expect((await stat(path.join(archive, "photos", "cover.avif"))).isFile()).toBe(true);
    expect((await stat(path.join(archive, "photos", "pic.png"))).isFile()).toBe(true);
    await expect(stat(path.join(archive, "only-junk"))).rejects.toThrow();
    await expect(stat(path.join(archive, "empty"))).rejects.toThrow();
    expect((await harness.call("tidy", { rootId: root.id })).cleanup).toEqual({
      junk: 0,
      emptyFolders: 0,
      extensions: 0,
    });
  });
});
