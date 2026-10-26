import { copyFile, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DuplicateSetPage, Root } from "../contract.js";
import { type EngineHarness, openEngine, testPicture } from "../test-support/engine-harness.js";

let archive: string;

let dataDir: string;

let harness: EngineHarness;

let root: Root;

const MTIME = new Date("2020-06-01T12:00:00Z");

/** Where a file goes in the archive, with its folder made. */
async function place(relPath: string): Promise<string> {
  const target = path.join(archive, ...relPath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });

  return target;
}

/** Copies `a.png` to another path, with the same date. */
async function copyOfA(relPath: string): Promise<void> {
  const target = await place(relPath);
  await copyFile(path.join(archive, "a.png"), target);
  await utimes(target, MTIME, MTIME);
}

function sets(request: { scope?: "all" | "exact" | "similar"; dismissed?: boolean } = {}) {
  return harness.call("duplicateSets", {
    rootId: root.id,
    level: "balanced",
    scope: request.scope ?? "all",
    dismissed: request.dismissed ?? false,
    offset: 0,
    limit: 50,
  });
}

function namesOf(page: DuplicateSetPage): string[][] {
  return page.sets.map((set) =>
    set.versions.flatMap((version) => version.files.map((file) => file.relPath)),
  );
}

beforeAll(async () => {
  archive = await mkdtemp(path.join(os.tmpdir(), "glazier-sets-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "glazier-sets-data-"));

  // Three byte-identical copies, one named like a copy; a picture and its smaller JPEG; a loner.
  await testPicture(2)
    .png()
    .toFile(await place("a.png"));
  await utimes(path.join(archive, "a.png"), MTIME, MTIME);
  await copyOfA("x/a.png");
  await copyOfA("y/a (1).png");
  await testPicture(3)
    .png()
    .toFile(await place("b.png"));
  await sharp(path.join(archive, "b.png"))
    .resize(320, 240)
    .jpeg({ quality: 60 })
    .toFile(await place("b-small.jpg"));
  await testPicture(5)
    .png()
    .toFile(await place("c.png"));

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

describe("duplicate sets", () => {
  it("makes one exact set of identical copies and one similar set of versions", async () => {
    const page = await sets();
    const a = await harness.file(root.id, "a.png");
    const exact = page.sets.find((set) => set.kind === "exact");
    const similar = page.sets.find((set) => set.kind === "similar");

    expect(page.counts).toEqual({ exact: 1, similar: 1, variants: 0, dismissed: 0 });
    expect(namesOf(page)).toEqual([
      ["a.png", "x/a.png", "y/a (1).png"],
      ["b.png", "b-small.jpg"],
    ]);
    expect(exact).toMatchObject({
      key: `exact:${a.sha256}`,
      keep: [a.id],
      keepReason: "shorter-path",
      reclaimableBytes: 2 * a.size,
      distance: null,
      dismissalId: null,
    });
    expect(similar).toMatchObject({ keepReason: "more-pixels", versions: [{}, {}] });
    expect((await sets({ scope: "exact" })).total).toBe(1);
  });

  it("hides a dismissed set while its files stay inside the dismissal", async () => {
    const page = await sets();
    const [exact, similar] = page.sets;

    if (!exact || !similar) {
      throw new Error("Expected an exact and a similar set");
    }

    const { dismissalId } = await harness.call("dismissDuplicateSet", {
      fileIds: exact.versions.flatMap((version) => version.files.map((file) => file.id)),
    });

    expect((await sets()).counts).toEqual({ exact: 0, similar: 1, variants: 0, dismissed: 1 });
    expect((await sets({ dismissed: true })).sets.map((set) => set.dismissalId)).toEqual([
      dismissalId,
    ]);
    // Losing a file keeps the set hidden…
    const copy = await harness.file(root.id, "y/a (1).png");
    const held = await harness.call("perform", { kind: "hold", fileIds: [copy.id] });

    if (held.job === null) {
      throw new Error("The hold did not start");
    }

    await harness.settle(held.job);
    expect((await sets()).counts).toEqual({ exact: 0, similar: 1, variants: 0, dismissed: 1 });

    // …gaining one brings it back.
    await copyOfA("z/a.png");
    await harness.settle(await harness.call("scanRoot", { rootId: root.id }));
    await harness.idle();

    expect(namesOf(await sets({ scope: "exact" }))).toEqual([["a.png", "x/a.png", "z/a.png"]]);
    expect((await sets()).counts.dismissed).toBe(0);

    await harness.call("restoreDuplicateSet", { dismissalId });
  });

  it("remembers the files a resolution keeps together until it is undone", async () => {
    const a = await harness.file(root.id, "a.png");
    const xa = await harness.file(root.id, "x/a.png");
    const za = await harness.file(root.id, "z/a.png");

    const preview = await harness.call("previewPlan", {
      kind: "resolve-duplicates",
      groups: [{ keep: [a.id, xa.id], remove: [za.id] }],
    });

    // A draft's dismissal hides nothing yet.
    expect((await sets()).counts).toEqual({ exact: 1, similar: 1, variants: 0, dismissed: 0 });

    await harness.settle(await harness.call("applyPlan", { planId: preview.planId }));

    expect((await sets()).counts).toEqual({ exact: 0, similar: 1, variants: 0, dismissed: 1 });

    await harness.call("undoPlan", { planId: preview.planId });
    await harness.idle();

    expect((await sets()).counts).toEqual({ exact: 1, similar: 1, variants: 0, dismissed: 0 });
    expect(namesOf(await sets({ scope: "exact" }))).toEqual([["a.png", "x/a.png", "z/a.png"]]);
  });
});
