import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileIdSchema } from "../contract.js";
import { testPicture } from "../test-support/engine-harness.js";
import { fingerprintStill } from "./fingerprint.js";
import { type FingerprintedFile, groupSimilarFiles } from "./group.js";

const noYield = async () => undefined;

const id = (value: number) => FileIdSchema.parse(value);

let folder: string;

beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "glazier-similar-"));
});

afterAll(async () => {
  await rm(folder, { force: true, recursive: true });
});

describe("similar media", () => {
  it("groups one picture saved as PNG, a smaller JPEG and an AVIF, and nothing else", async () => {
    const original = path.join(folder, "original.png");
    await testPicture(1).png().toFile(original);
    await sharp(original)
      .resize(320, 240)
      .jpeg({ quality: 55 })
      .toFile(path.join(folder, "small.jpg"));
    await sharp(original).avif({ quality: 50 }).toFile(path.join(folder, "copy.avif"));
    await testPicture(2).png().toFile(path.join(folder, "other.png"));
    await testPicture(3).png().toFile(path.join(folder, "third.png"));

    const names = ["original.png", "small.jpg", "copy.avif", "other.png", "third.png"];

    const files: FingerprintedFile[] = await Promise.all(
      names.map(async (name, index) => ({
        id: id(index + 1),
        aspect: 640 / 480,
        fingerprint: await fingerprintStill(sharp, path.join(folder, name)),
      })),
    );

    const clusters = await groupSimilarFiles(files, "balanced", noYield);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.kind).toBe("image");
    expect([...(clusters[0]?.ids ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("never matches pictures of different aspect ratios", async () => {
    const square = await fingerprintStill(sharp, path.join(folder, "original.png"));

    const clusters = await groupSimilarFiles(
      [
        { id: id(1), aspect: 1, fingerprint: square },
        { id: id(2), aspect: 16 / 9, fingerprint: square },
      ],
      "loose",
      noYield,
    );

    expect(clusters).toEqual([]);
  });

  it("matches footage by its frames only when the durations agree", async () => {
    const frame = (seed: number) => ({ hi: (seed * 2654435761) >>> 0, lo: (seed * 40503) >>> 0 });
    const frames = [1, 2, 3, 4, 5].map(frame);

    const motion = (durationMs: number) => ({ kind: "motion" as const, durationMs, frames });

    const clusters = await groupSimilarFiles(
      [
        { id: id(1), aspect: 16 / 9, fingerprint: motion(60_000) },
        { id: id(2), aspect: 16 / 9, fingerprint: motion(60_900) },
        { id: id(3), aspect: 16 / 9, fingerprint: motion(75_000) },
      ],
      "balanced",
      noYield,
    );

    expect(clusters.map((cluster) => [...cluster.ids].sort((a, b) => a - b))).toEqual([[1, 2]]);
  });
});
