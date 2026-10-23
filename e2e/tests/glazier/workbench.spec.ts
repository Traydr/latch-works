import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import {
  applyPlan,
  type GlazierSession,
  launchGlazier,
  openView,
  stubFolderDialog,
  waitForJobs,
} from "../../src/glazier.ts";

const execFileAsync = promisify(execFile);

/** Old enough that a conversion dropping the original's date would show. */
const ORIGINAL_MTIME = new Date("2022-05-06T07:08:09Z");

let archive: string;

let session: GlazierSession;

async function ffmpeg(...args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
}

function picture(seed: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <rect width="640" height="480" fill="hsl(${seed * 47} 70% 45%)"/>
    <circle cx="${100 + seed * 60}" cy="200" r="90" fill="#fff9"/>
    <rect x="${seed * 40}" y="320" width="200" height="80" fill="#0008"/></svg>`;

  return sharp(Buffer.from(svg));
}

/** Codec names of a file's streams, from ffprobe. */
async function streamCodecs(file: string): Promise<string[]> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "csv=p=0",
    file,
  ]);

  return stdout.split("\n").flatMap((line) => (line.trim() ? [line.trim()] : []));
}

async function heldFiles(): Promise<string[]> {
  const holding = path.join(archive, ".glazier-holding");
  const found: string[] = [];

  for (const batch of await readdir(holding).catch(() => [])) {
    const walk = async (folder: string, prefix: string) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          await walk(path.join(folder, entry.name), `${prefix}${entry.name}/`);
        } else {
          found.push(`${prefix}${entry.name}`);
        }
      }
    };

    await walk(path.join(holding, batch), "");
  }

  return found.sort();
}

/**
 * A small archive built for each run, because Glazier changes files: stills (one resized twin,
 * one AVIF misnamed .jpg), an animated GIF, H.264/AAC in MOV, VP9/Opus in WebM, MP4s with sound,
 * with a silent track and with no audio, an exact copy, system junk and an empty folder.
 */
test.beforeAll(async () => {
  test.setTimeout(120_000);
  archive = await mkdtemp(path.join(os.tmpdir(), "glazier-archive-"));

  for (const folder of ["photos", "clips", "dup", "empty"]) {
    await mkdir(path.join(archive, folder));
  }

  await picture(1)
    .png()
    .toFile(path.join(archive, "photos", "sunset.png"));
  await picture(1)
    .resize(320, 240)
    .jpeg({ quality: 60 })
    .toFile(path.join(archive, "photos", "sunset-small.jpg"));
  await picture(2)
    .png()
    .toFile(path.join(archive, "photos", "forest.png"));
  await picture(3)
    .avif({ quality: 50 })
    .toFile(path.join(archive, "photos", "cover.jpg"));

  const clip = (name: string) => path.join(archive, "clips", name);
  const testCard = ["-f", "lavfi", "-i", "testsrc2=s=320x240:d=3:r=12"];
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
  const h264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];

  await ffmpeg(...testCard, ...tone, ...h264, "-c:a", "aac", "-shortest", clip("with-sound.mp4"));
  await ffmpeg(
    ...testCard,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    ...h264,
    "-c:a",
    "aac",
    "-t",
    "3",
    clip("silent-track.mp4"),
  );
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "mandelbrot=s=320x240:r=12",
    "-t",
    "3",
    ...h264,
    clip("no-audio.mp4"),
  );
  await ffmpeg(...testCard, ...tone, ...h264, "-c:a", "aac", "-shortest", clip("talk.mov"));
  await ffmpeg(
    ...testCard,
    ...tone,
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "300k",
    "-c:a",
    "libopus",
    "-shortest",
    clip("scene.webm"),
  );
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=200x150:d=2:r=10",
    "-vf",
    "split[a][b];[a]palettegen[p];[b][p]paletteuse",
    clip("loop.gif"),
  );
  await copyFile(clip("with-sound.mp4"), path.join(archive, "dup", "with-sound-copy.mp4"));
  await writeFile(path.join(archive, ".DS_Store"), "junk");

  for (const name of ["sunset.png", "forest.png"]) {
    await utimes(path.join(archive, "photos", name), ORIGINAL_MTIME, ORIGINAL_MTIME);
  }

  for (const name of ["talk.mov", "scene.webm", "loop.gif"]) {
    await utimes(clip(name), ORIGINAL_MTIME, ORIGINAL_MTIME);
  }

  session = await launchGlazier();
});

test.afterAll(async () => {
  await session?.app.close();
  await rm(archive, { force: true, recursive: true });
});

test.describe.configure({ mode: "serial" });

test("a new root is scanned and its formats and findings reported", async () => {
  const { app, window } = session;
  await stubFolderDialog(app, archive);
  await window.getByRole("button", { name: "Add a root" }).first().click();
  await waitForJobs(window);

  // Four stills, six clips, the copy and .DS_Store; the symlink-free walk counts every one.
  await expect(window.locator('[data-stat="Files"]')).toContainText("12");
  await expect(window.locator('[data-finding="extension-mismatch"]')).toContainText("1");
  await expect(window.locator('[data-finding="junk"]')).toContainText("1");
  await expect(window.locator('[data-finding="empty-folder"]')).toContainText("1");
});

test("the resized JPEG is grouped with the picture it came from", async () => {
  const { window } = session;
  await openView(window, "Duplicates");
  await window.getByRole("button", { name: "Similar", exact: true }).click();
  await window.getByRole("button", { name: "Find similar" }).click();
  await waitForJobs(window);

  await window
    .getByRole("list", { name: "Groups" })
    .getByRole("button", { name: /sunset/ })
    .click();
  await expect(window.locator('[data-member="sunset-small.jpg"]')).toBeVisible();
  await expect(window.locator('[data-member="sunset.png"]')).toHaveAttribute("data-keep", "true");
});

test("silent tracks are told apart from sound", async () => {
  const { window } = session;
  await openView(window, "Sound");
  await window.getByRole("button", { name: "Measure sound" }).click();
  await waitForJobs(window);

  // The GIF is still an image here; only no-audio.mp4 lacks a track.
  await expect(window.getByRole("button", { name: /No audio track/ })).toContainText("1");
  await expect(window.getByRole("button", { name: /Silent track/ })).toContainText("1");
  await expect(window.getByRole("button", { name: /Has sound/ })).toContainText("4");
});

test("an exact duplicate goes to holding and the journal brings it back", async () => {
  const { window } = session;
  const copy = path.join(archive, "dup", "with-sound-copy.mp4");
  await openView(window, "Duplicates");
  await window.getByRole("button", { name: "Exact", exact: true }).click();
  await window.getByRole("button", { name: "Resolve this group" }).click();
  await applyPlan(window);

  await expect(stat(copy)).rejects.toThrow();
  expect(await heldFiles()).toEqual(["dup/with-sound-copy.mp4"]);

  await openView(window, "Journal");
  window.once("dialog", (dialog) => void dialog.accept());
  await window.getByRole("button", { name: "Undo" }).first().click();
  await waitForJobs(window);

  await expect.poll(async () => (await stat(copy).catch(() => null))?.isFile() ?? false).toBe(true);
  expect(await heldFiles()).toEqual([]);
});

test("stills become AVIF and everything that moves MP4, keeping each original's date", async () => {
  const { window } = session;
  await openView(window, "Optimize");
  // Stills, the animation, the MOV remux, the WebM re-encode and the misnamed AVIF.
  await expect(window.locator("[data-category]")).toHaveCount(5);

  for (const checkbox of await window.locator("[data-category] input[type=checkbox]").all()) {
    await checkbox.check();
  }

  await window.getByRole("button", { name: "Review conversions" }).click();
  await applyPlan(window);

  for (const [converted, codec] of [
    ["clips/talk.mp4", "h264"],
    ["clips/scene.mp4", "h264"],
    ["clips/loop.mp4", "h264"],
  ] as const) {
    expect(await streamCodecs(path.join(archive, converted))).toContain(codec);
  }

  for (const converted of [
    "photos/sunset.avif",
    "photos/forest.avif",
    "clips/talk.mp4",
    "clips/scene.mp4",
    "clips/loop.mp4",
  ]) {
    const converted_ = await stat(path.join(archive, converted));
    expect(Math.trunc(converted_.mtimeMs / 1000), converted).toBe(ORIGINAL_MTIME.getTime() / 1000);
  }

  await expect(stat(path.join(archive, "photos", "cover.avif"))).resolves.toBeTruthy();
  expect(await heldFiles()).toEqual(
    expect.arrayContaining([
      "clips/loop.gif",
      "clips/scene.webm",
      "clips/talk.mov",
      "photos/sunset.png",
    ]),
  );
});
