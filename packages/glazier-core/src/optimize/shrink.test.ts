import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Root } from "../contract.js";
import { hasSvtAv1 } from "../media/ffmpeg-transcode.js";
import { type EngineHarness, openEngine } from "../test-support/engine-harness.js";

function which(name: string): string | null {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const ffmpeg = which("ffmpeg");

const svtAv1 = await hasSvtAv1(ffmpeg);

/** Two seconds of moving 640×360 picture, with grain so it costs bits, as H.264 or AV1. */
function makeClip(target: string, encode: readonly string[]): void {
  if (ffmpeg === null) {
    throw new Error("ffmpeg is needed to make the clips");
  }

  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=30:d=2,noise=alls=24:allf=t",
      ...encode,
      "-pix_fmt",
      "yuv420p",
      target,
    ],
    // SVT-AV1 prints its own banner whatever ffmpeg's log level.
    { stdio: "ignore" },
  );
}

let archive: string;

let dataDir: string;

let harness: EngineHarness;

let root: Root;

beforeAll(async () => {
  archive = await mkdtemp(path.join(os.tmpdir(), "glazier-shrink-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "glazier-shrink-data-"));

  if (svtAv1) {
    await mkdir(path.join(archive, "clips"));
    makeClip(path.join(archive, "clips", "busy.mp4"), ["-c:v", "libx264", "-crf", "10"]);
    makeClip(path.join(archive, "clips", "lean.mp4"), ["-c:v", "libx264", "-b:v", "40k"]);
    makeClip(path.join(archive, "clips", "done.mp4"), ["-c:v", "libsvtav1", "-preset", "12"]);
  }

  harness = await openEngine(dataDir);
  await harness.call("updateSettings", {
    preferredFolders: [],
    similarity: "balanced",
    spotVariants: false,
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

describe.skipIf(!svtAv1)("shrink", () => {
  it("offers busy videos for AV1 and leaves compact and AV1 ones as they are", async () => {
    const busy = await harness.file(root.id, "clips/busy.mp4");
    const summary = await harness.call("shrinkSummary", { rootId: root.id });

    expect(summary.items.map((item) => item.fileId)).toEqual([busy.id]);
    expect(summary.items[0]?.estimatedBytes).toBeLessThan(busy.size);
    expect(summary.skipped).toEqual(
      expect.arrayContaining([
        { reason: "Already compact", files: 1 },
        { reason: "Already AV1", files: 1 },
      ]),
    );
    expect((await harness.call("tidy", { rootId: root.id })).shrink.files).toBe(1);
  });

  it("re-encodes the batch with SVT-AV1 in place, and Undo brings the original back", async () => {
    const busy = await harness.file(root.id, "clips/busy.mp4");

    const { preview, job } = await harness.call("perform", {
      kind: "shrink-videos",
      rootId: root.id,
      limitBytes: null,
    });

    if (job === null) {
      throw new Error("The shrink did not start");
    }

    await harness.settle(job);

    const plan = await harness.call("getPlan", { planId: preview.planId });
    const steps = await harness.call("planSteps", { planId: preview.planId, offset: 0, limit: 5 });
    const shrunk = await harness.file(root.id, "clips/busy.mp4");

    expect(plan).toMatchObject({ title: "Shrank 1 video", done: 1 });
    expect(steps.steps[0]?.message).toBe("Encoded with SVT-AV1");
    expect(shrunk.videoCodec).toBe("av1");
    expect(shrunk.size).toBeLessThan(busy.size);
    expect((await harness.call("shrinkSummary", { rootId: root.id })).items).toEqual([]);

    await harness.settle(await harness.call("undoPlan", { planId: preview.planId }));
    await harness.idle();

    expect((await harness.file(root.id, "clips/busy.mp4")).videoCodec).toBe("h264");
  });
});
