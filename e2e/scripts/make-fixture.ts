import { execFile } from "node:child_process";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { FIXTURE_ARCHIVE_DIR, LOCKSTEP_SOURCE_DIR } from "../src/env.ts";
import {
  FIXTURE_ITEMS,
  type FixtureItem,
  fixtureMtimeMs,
  LOCKSTEP_SOURCE_ITEMS,
} from "../src/fixture.ts";

const execFileAsync = promisify(execFile);

/**
 * Renders the fixture manifest to disk. Deterministic: the same manifest
 * always produces the same tree, so a rerun is a no-op for the archive's
 * identity (sizes may differ byte-for-byte across sharp versions; the suite
 * only depends on paths, kinds and mtimes).
 */
interface Rgb {
  b: number;
  g: number;
  r: number;
}

function colourFor(index: number): Rgb {
  return { b: (index * 89) % 256, g: (index * 53) % 256, r: (index * 37) % 256 };
}

async function writeImage(target: string, entry: FixtureItem, index: number): Promise<void> {
  const base = sharp({
    create: { background: colourFor(index), channels: 3, height: 48, width: 64 },
  });
  const extension = path.extname(entry.name).toLowerCase();
  if (extension === ".png") {
    await base.png().toFile(target);
  } else if (extension === ".gif") {
    await base.gif().toFile(target);
  } else {
    await base.jpeg().toFile(target);
  }
}

async function writeVideo(target: string, index: number): Promise<void> {
  const { r, g, b } = colourFor(index);
  const hex = [r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("");
  await execFileAsync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x${hex}:s=64x48:d=4:r=10`,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    target,
  ]);
}

async function writePdf(target: string): Promise<void> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= 3; page += 1) {
    const sheet = document.addPage([300, 400]);
    sheet.drawText(`Fixture page ${page}`, { font, size: 24, x: 40, y: 340 });
  }
  await writeFile(target, await document.save());
}

async function writeArchive(root: string, items: readonly FixtureItem[]): Promise<void> {
  await rm(root, { force: true, recursive: true });
  for (const [index, entry] of items.entries()) {
    const target = path.join(root, ...entry.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    switch (entry.kind) {
      case "image":
      case "gif":
        await writeImage(target, entry, index);
        break;
      case "video":
        await writeVideo(target, index);
        break;
      case "pdf":
        await writePdf(target);
        break;
    }
    const mtime = new Date(fixtureMtimeMs(entry));
    await utimes(target, mtime, mtime);
  }
  console.log(`fixture: ${items.length} items written to ${root}`);
}

async function main(): Promise<void> {
  await writeArchive(FIXTURE_ARCHIVE_DIR, FIXTURE_ITEMS);
  await writeArchive(LOCKSTEP_SOURCE_DIR, LOCKSTEP_SOURCE_ITEMS);
}

await main();
