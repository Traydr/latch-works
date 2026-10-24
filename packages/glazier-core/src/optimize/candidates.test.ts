import { copyFile, mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Root } from "../contract.js";
import { type EngineHarness, openEngine, testPicture } from "../test-support/engine-harness.js";

let archive: string;

let dataDir: string;

let harness: EngineHarness;

let root: Root;

/** A tiny flat PNG: no AVIF of it comes out smaller. */
function tinyPng(colour: string) {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: colour } }).png();
}

async function convertibleNames(): Promise<string[]> {
  const { ids } = await harness.call("listFileIds", {
    rootId: root.id,
    search: "",
    kinds: [],
    formats: [],
    audioStates: [],
    flags: ["convertible"],
    dir: null,
  });

  return (await harness.call("getFiles", { ids })).map((row) => row.relPath).sort();
}

beforeAll(async () => {
  archive = await mkdtemp(path.join(os.tmpdir(), "glazier-candidates-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "glazier-candidates-data-"));

  await tinyPng("#336699").toFile(path.join(archive, "tiny.png"));
  await testPicture(6).png().toFile(path.join(archive, "twin-a.png"));
  await copyFile(path.join(archive, "twin-a.png"), path.join(archive, "twin-b.png"));
  await utimes(path.join(archive, "twin-a.png"), new Date(2020, 0, 1), new Date(2020, 0, 1));

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

describe("convert candidates", () => {
  it("leave out every copy in an open set of identical copies, unless it was dismissed", async () => {
    expect(await convertibleNames()).toEqual(["tiny.png"]);
    expect((await harness.call("optimizeSummary", { rootId: root.id })).skipped).toEqual([
      { reason: "Identical copies (resolve duplicates first)", files: 2 },
    ]);

    const twins = await Promise.all(
      ["twin-a.png", "twin-b.png"].map((name) => harness.file(root.id, name)),
    );

    const { dismissalId } = await harness.call("dismissDuplicateSet", {
      fileIds: twins.map((twin) => twin.id),
    });

    expect(await convertibleNames()).toEqual(["tiny.png", "twin-a.png", "twin-b.png"]);

    await harness.call("restoreDuplicateSet", { dismissalId });
    expect(await convertibleNames()).toEqual(["tiny.png"]);
  });

  it("leave out a file whose conversion came out larger, until its bytes change", async () => {
    const tiny = await harness.file(root.id, "tiny.png");

    const { preview, job } = await harness.call("perform", {
      kind: "optimize",
      rootId: root.id,
      categories: ["still-to-avif"],
      fileIds: [tiny.id],
    });

    if (job === null) {
      throw new Error("The conversion did not start");
    }

    await harness.settle(job);

    const steps = await harness.call("planSteps", { planId: preview.planId, offset: 0, limit: 5 });
    expect(steps.steps[0]?.status).toBe("skipped");
    expect(steps.steps[0]?.message).toMatch(
      /^Kept the original: the result was larger \(\d+ B → \d+ B\)$/,
    );

    expect(await convertibleNames()).toEqual([]);
    expect((await harness.call("optimizeSummary", { rootId: root.id })).skipped).toContainEqual({
      reason: "Already as small as they get",
      files: 1,
    });

    await tinyPng("#993366").toFile(path.join(archive, "tiny.png"));
    await utimes(path.join(archive, "tiny.png"), new Date(2024, 0, 1), new Date(2024, 0, 1));
    await harness.settle(await harness.call("scanRoot", { rootId: root.id }));
    // New bytes need a new similarity check first, which the scan queues.
    await harness.idle();

    expect(await convertibleNames()).toEqual(["tiny.png"]);
  });
});
