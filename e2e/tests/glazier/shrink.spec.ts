import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  chooseFolder,
  type GlazierSession,
  latestToast,
  launchGlazier,
  openView,
  waitForJobs,
} from "../../src/glazier.ts";
import { heldFiles, streamCodecs } from "../../src/glazier-archive.ts";

const execFileAsync = promisify(execFile);

/** Two seconds of 640×360 picture with a tone, as H.264 at the given rate settings. */
async function makeClip(target: string, picture: string, rate: readonly string[]): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    picture,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-t",
    "2",
    "-c:v",
    "libx264",
    ...rate,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    target,
  ]);
}

let archive: string;

let session: GlazierSession;

const clip = (name: string) => path.join(archive, "clips", name);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  archive = await mkdtemp(path.join(os.tmpdir(), "oriel-shrink-"));
  await mkdir(path.join(archive, "clips"));
  // Grain in every frame costs bits, so this one is busy; the other is compact already.
  await makeClip(clip("busy.mp4"), "testsrc2=s=640x360:r=30,noise=alls=24:allf=t", ["-crf", "10"]);
  await makeClip(clip("lean.mp4"), "mandelbrot=s=640x360:r=30", ["-b:v", "40k"]);
  session = await launchGlazier();
});

test.afterAll(async () => {
  await session?.app.close();
  await rm(archive, { force: true, recursive: true });
});

test("Shrink re-encodes a busy video to AV1, leaves a compact one, and Undo restores it", async () => {
  const { window } = session;

  await window.getByRole("button", { name: /Choose folder/i }).click();
  await chooseFolder(window, archive);
  await waitForJobs(window);

  await openView(window, "shrink");
  await window
    .locator("main")
    .getByRole("button", { name: /^Shrink 1/ })
    .click();
  await expect(latestToast(window)).toContainText("Shrank 1 video", { timeout: 120_000 });
  await waitForJobs(window);

  expect(await streamCodecs(clip("busy.mp4"))).toEqual(["av1", "aac"]);
  expect(await streamCodecs(clip("lean.mp4"))).toEqual(["h264", "aac"]);
  expect(await heldFiles(session.userDataDir, archive)).toEqual(["clips/busy.mp4"]);
  await expect(window.getByText("Nothing left to shrink")).toBeVisible();

  await latestToast(window).getByRole("button", { name: "Undo" }).click();
  await expect(latestToast(window)).toContainText("Undid", { timeout: 60_000 });
  await waitForJobs(window);

  expect(await streamCodecs(clip("busy.mp4"))).toEqual(["h264", "aac"]);
});
