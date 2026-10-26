import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DuplicateScope, DuplicateSet, Root, Settings } from "../contract.js";
import { type EngineHarness, openEngine, testPicture } from "../test-support/engine-harness.js";

type Picture = ReturnType<typeof sharp>;

let archive: string;

let dataDir: string;

let harness: EngineHarness;

let root: Root;

const SETTINGS: Settings = {
  preferredFolders: [],
  similarity: "balanced",
  spotVariants: false,
  reencodeQuality: "high",
  autoAnalyze: true,
};

/** A caption box, as a translated page adds, in the top right. */
const CAPTION = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <rect x="530" y="30" width="70" height="32" rx="8" fill="#fff"/>
  <rect x="542" y="42" width="46" height="8" fill="#111"/>
</svg>`);

/** Another face: a dark shape where the picture's light circle was. */
const FACE = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <ellipse cx="150" cy="160" rx="30" ry="24" fill="#123"/>
</svg>`);

async function write(relPath: string, image: Picture): Promise<void> {
  const target = path.join(archive, ...relPath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await image.toFile(target);
}

async function picture(overlay: Buffer | null): Promise<Picture> {
  const base = await testPicture(7).png().toBuffer();

  return overlay ? sharp(base).composite([{ input: overlay }]) : sharp(base);
}

async function sets(scope: DuplicateScope): Promise<DuplicateSet[]> {
  const page = await harness.call("duplicateSets", {
    rootId: root.id,
    level: "balanced",
    scope,
    dismissed: false,
    offset: 0,
    limit: 50,
  });

  return page.sets;
}

/** A set's files by name, grouped picture by picture. */
function picturesOf(set: DuplicateSet): string[][] {
  const groups = new Map<number, string[]>();

  set.versions.forEach((version, index) => {
    const picture = set.pictures?.[index] ?? index;
    const names = groups.get(picture) ?? [];
    names.push(...version.files.map((file) => file.relPath));
    groups.set(picture, names);
  });

  return [...groups.values()].map((names) => names.sort());
}

function keptNames(set: DuplicateSet): string[] {
  const names = new Map(
    set.versions.flatMap((version) => version.files.map((file) => [file.id, file.relPath])),
  );

  return set.keep.map((id) => names.get(id) ?? "").sort();
}

beforeAll(async () => {
  archive = await mkdtemp(path.join(os.tmpdir(), "glazier-variants-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "glazier-variants-data-"));

  // One page in three versions, one folder; another site's copies of two of them, one smaller.
  await write("fanbox/page-jp.png", await picture(null));
  await write("fanbox/page-en.png", await picture(CAPTION));
  await write("fanbox/page-clean.png", await picture(FACE));
  await write("pixiv/page.jpg", (await picture(null)).resize(480, 360).jpeg({ quality: 70 }));
  await write("pixiv/page-en.png", (await picture(CAPTION)).png({ compressionLevel: 1 }));

  harness = await openEngine(dataDir);
  await harness.call("updateSettings", SETTINGS);
  root = await harness.call("addRoot", { path: archive });
  await harness.idle();
});

afterAll(async () => {
  await harness.idle();
  harness.engine.close();
  await rm(archive, { force: true, recursive: true });
  await rm(dataDir, { force: true, recursive: true });
});

describe("Spot variants", () => {
  it("is off by default: the five files are one set that keeps one", async () => {
    const [set] = await sets("similar");

    expect(set?.pictures).toBeNull();
    expect(set?.keep).toHaveLength(1);
    expect(set?.versions).toHaveLength(5);
  });

  it("keeps each picture once, its copy in the folder holding the most of them", async () => {
    await harness.call("updateSettings", { ...SETTINGS, spotVariants: true });
    await harness.idle();

    const [set] = await sets("similar");

    if (!set) {
      throw new Error("Expected the page's set");
    }

    expect(picturesOf(set).sort()).toEqual([
      ["fanbox/page-clean.png"],
      ["fanbox/page-en.png", "pixiv/page-en.png"],
      ["fanbox/page-jp.png", "pixiv/page.jpg"],
    ]);
    expect(keptNames(set)).toEqual([
      "fanbox/page-clean.png",
      "fanbox/page-en.png",
      "fanbox/page-jp.png",
    ]);
  });

  it("moves a set of variants alone out of duplicates", async () => {
    await harness.call("perform", {
      kind: "hold",
      fileIds: [
        (await harness.file(root.id, "pixiv/page.jpg")).id,
        (await harness.file(root.id, "pixiv/page-en.png")).id,
      ],
    });
    await harness.idle();

    expect(await sets("similar")).toEqual([]);

    const [variants] = await sets("variants");

    expect(variants?.keepReason).toBe("different-pictures");
    expect(variants ? keptNames(variants) : []).toEqual([
      "fanbox/page-clean.png",
      "fanbox/page-en.png",
      "fanbox/page-jp.png",
    ]);

    const tidy = await harness.call("tidy", { rootId: root.id });

    expect(tidy.duplicates.similar.sets).toBe(0);
  });
});
