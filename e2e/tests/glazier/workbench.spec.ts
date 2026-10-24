import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import {
  type GlazierSession,
  latestToast,
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
  // Each clip shows its own test pattern, so only the exact copy below counts as a duplicate.
  const pattern = (source: string) => ["-f", "lavfi", "-i", `${source}=s=320x240:d=3:r=12`];
  const testCard = pattern("testsrc2");
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
  const h264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];

  await ffmpeg(...testCard, ...tone, ...h264, "-c:a", "aac", "-shortest", clip("with-sound.mp4"));
  await ffmpeg(
    ...pattern("smptebars"),
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
  await ffmpeg(
    ...pattern("zoneplate"),
    ...tone,
    ...h264,
    "-c:a",
    "aac",
    "-shortest",
    clip("talk.mov"),
  );
  await ffmpeg(
    ...pattern("yuvtestsrc"),
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
    "colorspectrum=s=200x150:d=2:r=10",
    "-vf",
    "split[a][b];[a]palettegen[p];[b][p]paletteuse",
    clip("loop.gif"),
  );
  // Videos the WebCodecs path stumbles on: VP9 with an alpha channel, an odd frame width, and
  // MPEG-4 Part 2, which WebCodecs cannot decode at all.
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "cellauto=s=450x600:rate=25",
    "-t",
    "2",
    "-vf",
    "format=yuva420p",
    "-c:v",
    "libvpx-vp9",
    "-auto-alt-ref",
    "0",
    clip("sticker.webm"),
  );
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "life=s=720x540:rate=25:ratio=0.2",
    "-t",
    "2",
    "-vf",
    "scale=717:534",
    "-c:v",
    "libvpx-vp9",
    clip("odd.webm"),
  );
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "rgbtestsrc=s=640x360:d=2:r=25",
    "-c:v",
    "mpeg4",
    clip("old.mp4"),
  );
  await copyFile(clip("with-sound.mp4"), path.join(archive, "dup", "with-sound-copy.mp4"));
  await writeFile(path.join(archive, ".DS_Store"), "junk");

  for (const name of ["sunset.png", "forest.png"]) {
    await utimes(path.join(archive, "photos", name), ORIGINAL_MTIME, ORIGINAL_MTIME);
  }

  for (const name of [
    "talk.mov",
    "scene.webm",
    "loop.gif",
    "sticker.webm",
    "odd.webm",
    "old.mp4",
  ]) {
    await utimes(clip(name), ORIGINAL_MTIME, ORIGINAL_MTIME);
  }

  session = await launchGlazier();
});

test.afterAll(async () => {
  await session?.app.close();
  await rm(archive, { force: true, recursive: true });
});

test.describe.configure({ mode: "serial" });

test("a new folder is scanned and Tidy lists what to do with it", async () => {
  const { app, window } = session;

  await stubFolderDialog(app, archive);
  await window.getByRole("button", { name: /Choose Folder/ }).click();
  // The scan, then the similar and sound analysis it queues in the background.
  await waitForJobs(window);

  const step = (id: string) => window.locator(`[data-step="${id}"]`);

  await expect(window.getByText("15 files", { exact: false }).first()).toBeVisible();
  // The copy of with-sound.mp4, and sunset.png with its resized JPEG.
  await expect(step("duplicates")).toContainText("1 set of identical copies");
  await expect(step("duplicates")).toContainText("1 set of similar versions");
  await expect(step("silent")).toContainText("1 video with a silent soundtrack");
  await expect(step("cleanup")).toContainText("1 junk file");
  await expect(step("cleanup")).toContainText("1 empty folder");
  await expect(step("cleanup")).toContainText("1 wrong extension");
  await expect(step("convert")).toHaveAttribute("data-state", "todo");
});

test("the resized JPEG is grouped with the picture it came from", async () => {
  const { window } = session;

  await openView(window, "duplicates");
  await window.getByRole("button", { name: /^Similar/ }).click();
  await window.locator("[data-set-key]", { hasText: "sunset" }).first().click();

  await expect(window.locator('tr[data-file-name="sunset-small.jpg"]')).toHaveAttribute(
    "data-keep",
    "false",
  );
  await expect(window.locator('tr[data-file-name="sunset.png"]')).toHaveAttribute(
    "data-keep",
    "true",
  );

  // The number key picks the other version; nothing changes on disk until Return.
  await window.keyboard.press("2");
  await expect(window.locator('tr[data-file-name="sunset-small.jpg"]')).toHaveAttribute(
    "data-keep",
    "true",
  );
  await window.keyboard.press("1");
  await expect(window.locator('tr[data-file-name="sunset.png"]')).toHaveAttribute(
    "data-keep",
    "true",
  );
});

test("silent tracks are told apart from sound", async () => {
  const { window } = session;

  await openView(window, "library");
  await window.getByRole("button", { name: "Sound", exact: true }).click();

  // The GIF is still an image here; no-audio.mp4 and the three silent test patterns lack a track.
  await expect(window.locator("label", { hasText: "No audio track" })).toContainText("4");
  await expect(window.locator("label", { hasText: "Silent track" })).toContainText("1");
  await expect(window.locator("label", { hasText: "Has sound" })).toContainText("4");
  await window.keyboard.press("Escape");
});

test("Return resolves a duplicate set into holding, and Undo brings it back", async () => {
  const { window } = session;
  const copy = path.join(archive, "dup", "with-sound-copy.mp4");

  await openView(window, "duplicates");
  await window.getByRole("button", { name: /^Identical/ }).click();
  await window.locator("[data-set-key^='exact:']").first().click();
  // The copy-style name loses to the original.
  await expect(window.locator('tr[data-file-name="with-sound.mp4"]')).toHaveAttribute(
    "data-keep",
    "true",
  );

  await window.keyboard.press("Enter");
  await expect(latestToast(window)).toContainText("Resolved 1 duplicate set");
  await expect(stat(copy)).rejects.toThrow();
  expect(await heldFiles()).toEqual(["dup/with-sound-copy.mp4"]);

  await latestToast(window).getByRole("button", { name: "Undo" }).click();
  await waitForJobs(window);
  await expect.poll(async () => (await stat(copy).catch(() => null))?.isFile() ?? false).toBe(true);
  expect(await heldFiles()).toEqual([]);
});

test("Convert turns stills into AVIF and everything that moves into MP4, keeping dates", async () => {
  const { window } = session;

  await openView(window, "tidy");
  await window
    .locator('[data-step="convert"]')
    .getByRole("button", { name: /^Convert/ })
    .click();
  await expect(latestToast(window)).toContainText("Converted", { timeout: 180_000 });
  await waitForJobs(window);

  for (const [converted, codec] of [
    ["clips/talk.mp4", "h264"],
    ["clips/scene.mp4", "h264"],
    ["clips/loop.mp4", "h264"],
    ["clips/sticker.mp4", "h264"],
    ["clips/odd.mp4", "h264"],
    ["clips/old.mp4", "h264"],
  ] as const) {
    expect(await streamCodecs(path.join(archive, converted))).toContain(codec);
  }

  for (const converted of [
    "photos/sunset.avif",
    "photos/forest.avif",
    "clips/talk.mp4",
    "clips/scene.mp4",
    "clips/loop.mp4",
    "clips/sticker.mp4",
    "clips/odd.mp4",
    "clips/old.mp4",
  ]) {
    const written = await stat(path.join(archive, converted));

    expect(Math.trunc(written.mtimeMs / 1000), converted).toBe(ORIGINAL_MTIME.getTime() / 1000);
  }

  expect(await heldFiles()).toEqual(
    expect.arrayContaining([
      "clips/loop.gif",
      "clips/old.mp4",
      "clips/odd.webm",
      "clips/scene.webm",
      "clips/sticker.webm",
      "clips/talk.mov",
      "photos/sunset.png",
    ]),
  );
  await expect(window.locator('[data-step="convert"]')).toHaveAttribute("data-state", "done");
});

test("Clean up fixes the extension, holds the junk and removes the empty folder", async () => {
  const { window } = session;

  await openView(window, "tidy");
  await window.locator('[data-step="cleanup"]').getByRole("button", { name: "Clean up" }).click();
  await expect(latestToast(window)).toContainText("Cleaned up");

  await expect(stat(path.join(archive, "photos", "cover.avif"))).resolves.toBeTruthy();
  await expect(stat(path.join(archive, "empty"))).rejects.toThrow();
  expect(await heldFiles()).toEqual(expect.arrayContaining([".DS_Store"]));
  await expect(window.locator('[data-step="cleanup"]')).toHaveAttribute("data-state", "done");
});
