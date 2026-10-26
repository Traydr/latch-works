import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

/** Old enough that a conversion dropping the original's date would show. */
export const ORIGINAL_MTIME = new Date("2022-05-06T07:08:09Z");

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
export async function streamCodecs(file: string): Promise<string[]> {
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

/**
 * What holding has, as paths inside the archive. Holding lives in Glazier's data folder, one
 * folder per root and a batch folder per change below it, never inside the archive.
 */

export async function heldFiles(userDataDir: string, archive: string): Promise<string[]> {
  const holding = path.join(userDataDir, "holding");
  const found: string[] = [];

  const walk = async (folder: string, prefix: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        await walk(path.join(folder, entry.name), `${prefix}${entry.name}/`);
      } else {
        found.push(`${prefix}${entry.name}`);
      }
    }
  };

  for (const rootFolder of await readdir(holding).catch(() => [])) {
    for (const batch of await readdir(path.join(holding, rootFolder)).catch(() => [])) {
      await walk(path.join(holding, rootFolder, batch), "");
    }
  }

  await expect(stat(path.join(archive, ".glazier-holding"))).rejects.toThrow();

  return found.sort();
}

/**
 * A small archive, built fresh for each spec, because Glazier changes files: stills (one resized twin,
 * one AVIF misnamed .jpg), an animated GIF, H.264/AAC in MOV, VP9/Opus in WebM, MP4s with sound,
 * with a silent track and with no audio, an exact copy, system junk and an empty folder.
 */
export async function buildGlazierArchive(): Promise<string> {
  const archive = await mkdtemp(path.join(os.tmpdir(), "glazier-archive-"));

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
  await writeFile(path.join(archive, "._sunset.png"), "junk");

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

  return archive;
}
