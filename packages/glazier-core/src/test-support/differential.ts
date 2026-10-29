/**
 * The differential run between glazier-core and Oriel RS's Rust engine (plan 063, "Keeping two
 * implementations honest"): one throwaway archive, scanned and analysed by each engine on its own
 * copy, and a report of what each made of it. `engine/differential.test.ts` writes glazier-core's
 * report; `apps/oriel-rs/crates/core-tidy/tests/differential.rs` makes Rust's the same way and
 * compares. Files are named by their path in the archive, so the two reports compare whatever
 * ids the catalogs gave them.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import sharp from "sharp";
import { z } from "zod";

import { CatalogDatabase } from "../catalog/database.js";
import {
  type DuplicateSet,
  type FileId,
  FileIdSchema,
  isCloseCall,
  type Root,
  type SimilarityLevel,
  SimilarityLevelSchema,
} from "../contract.js";
import { computeSimilarClusters } from "../duplicates/queries.js";
import type { EngineHarness } from "./engine-harness.js";

const execFileAsync = promisify(execFile);

/** Old enough that a conversion dropping the original's date would show. */
const ORIGINAL_MTIME = new Date("2022-05-06T07:08:09Z");

/** Copies made later than the originals, as a copy would be. */
const COPIED_MTIME = new Date("2023-01-02T03:04:05Z");

async function ffmpeg(...args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
}

/** e2e's `glazier-archive.ts` picture: a fill, a disc and a bar, different for each seed. */
function archivePicture(seed: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <rect width="640" height="480" fill="hsl(${seed * 47} 70% 45%)"/>
    <circle cx="${100 + seed * 60}" cy="200" r="90" fill="#fff9"/>
    <rect x="${seed * 40}" y="320" width="200" height="80" fill="#0008"/></svg>`;

  return sharp(Buffer.from(svg));
}

/** e2e's `variants.spec.ts` picture: soft fills, a hard edge and a stroke. */
function variantPicture(seed: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${(seed * 47) % 360} 70% 40%)"/>
      <stop offset="1" stop-color="hsl(${(seed * 47 + 160) % 360} 60% 70%)"/>
    </linearGradient></defs>
    <rect width="640" height="480" fill="url(#g)"/>
    <circle cx="${120 + ((seed * 83) % 400)}" cy="${100 + ((seed * 61) % 280)}" r="${60 + (seed % 5) * 20}" fill="#fff8"/>
    <rect x="${(seed * 37) % 500}" y="300" width="140" height="${40 + (seed % 3) * 30}" fill="#0008"/>
    <path d="M0 ${200 + (seed % 7) * 20} Q 320 ${seed % 2 ? 0 : 480} 640 240" stroke="#222" stroke-width="18" fill="none"/>
  </svg>`;

  return sharp(Buffer.from(svg));
}

/** A caption box, as a translated page adds, in the top right. */
const CAPTION = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <rect x="530" y="30" width="70" height="32" rx="8" fill="#fff"/>
  <rect x="542" y="42" width="46" height="8" fill="#111"/>
</svg>`);

/** Another face: a dark shape on the left. */
const FACE = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <ellipse cx="150" cy="160" rx="30" ry="24" fill="#123"/>
</svg>`);

async function variant(seed: number, overlay: Buffer | null) {
  const base = await variantPicture(seed).png().toBuffer();

  return overlay ? sharp(base).composite([{ input: overlay }]) : sharp(base);
}

/**
 * Builds the archive into an empty folder: e2e's Glazier archive (stills with a resized twin and
 * an AVIF misnamed .jpg, an animated GIF, H.264/AAC in MOV, VP9/Opus in WebM, MP4s with sound,
 * with a silent track and with no audio, an exact copy, system junk and an empty folder), the
 * Spot variants page from `variants.spec.ts`, and a few copies the keeper rules tell apart.
 * Homebrew's ffmpeg makes the videos, as e2e's builder does; the odd-width WebM shows a test card
 * at a set bitrate rather than e2e's 16 MB of noise, so the committed archive stays small.
 */
export async function buildDifferentialArchive(archive: string): Promise<void> {
  const at = (...parts: string[]) => path.join(archive, ...parts);

  for (const folder of ["photos", "clips", "dup", "empty", "pages/fanbox", "pages/pixiv", "alt"]) {
    await mkdir(at(...folder.split("/")), { recursive: true });
  }

  await archivePicture(1).png().toFile(at("photos", "sunset.png"));
  await archivePicture(1)
    .resize(320, 240)
    .jpeg({ quality: 60 })
    .toFile(at("photos", "sunset-small.jpg"));
  await archivePicture(2).png().toFile(at("photos", "forest.png"));
  await archivePicture(3).avif({ quality: 50 }).toFile(at("photos", "cover.jpg"));
  await copyFile(at("photos", "forest.png"), at("dup", "forest (1).png"));
  await copyFile(at("photos", "forest.png"), at("photos", "forest copy.png"));

  const clip = (name: string) => at("clips", name);
  const pattern = (source: string) => ["-f", "lavfi", "-i", `${source}=s=320x240:d=3:r=12`];
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
  const h264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];

  await ffmpeg(
    ...pattern("testsrc2"),
    ...tone,
    ...h264,
    "-c:a",
    "aac",
    "-shortest",
    clip("with-sound.mp4"),
  );
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
    "-b:v",
    "300k",
    clip("sticker.webm"),
  );
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=720x540:rate=25",
    "-t",
    "2",
    "-vf",
    "scale=717:534",
    "-c:v",
    "libvpx-vp9",
    // e2e's clip is 16 MB of the Game of Life; a test card is as odd a width and compresses.
    "-b:v",
    "300k",
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
  // The same footage again, re-encoded smaller: a similar version of with-sound.mp4.
  await ffmpeg(
    "-i",
    clip("with-sound.mp4"),
    "-vf",
    "scale=240:180",
    ...h264,
    "-crf",
    "35",
    "-c:a",
    "aac",
    clip("with-sound-small.mp4"),
  );
  await copyFile(clip("with-sound.mp4"), at("dup", "with-sound-copy.mp4"));
  await writeFile(at("._sunset.png"), "junk");
  await writeFile(at("notes.txt"), "not media");

  // One page in three versions in one folder, and another site's copies of two of them.
  const write = async (relPath: string, image: ReturnType<typeof sharp>) => {
    await image.toFile(at(...relPath.split("/")));
  };

  await write("pages/fanbox/101_jp.png", await variant(7, null));
  await write("pages/fanbox/101_en.png", await variant(7, CAPTION));
  await write("pages/fanbox/101_clean.png", await variant(7, FACE));
  await write(
    "pages/pixiv/900_p0.jpg",
    (await variant(7, null)).resize(480, 360).jpeg({ quality: 70 }),
  );
  await write("pages/pixiv/900_p1.png", (await variant(7, CAPTION)).png({ compressionLevel: 1 }));
  // Two outfits of another picture, and nothing else.
  await write("alt/outfit-a.png", await variant(3, null));
  await write("alt/outfit-b.png", await variant(3, FACE));

  for (const relPath of [
    "photos/sunset.png",
    "photos/forest.png",
    "clips/talk.mov",
    "clips/scene.webm",
    "clips/loop.gif",
    "clips/sticker.webm",
    "clips/odd.webm",
    "clips/old.mp4",
  ]) {
    await utimes(at(...relPath.split("/")), ORIGINAL_MTIME, ORIGINAL_MTIME);
  }

  for (const relPath of [
    "dup/forest (1).png",
    "photos/forest copy.png",
    "dup/with-sound-copy.mp4",
  ]) {
    await utimes(at(...relPath.split("/")), COPIED_MTIME, COPIED_MTIME);
  }
}

export const ArchiveManifestSchema = z.object({
  about: z.string(),
  /** Every file, with the mtime a copy must carry, since Git keeps no dates. */
  files: z.array(z.object({ path: z.string(), mtimeMs: z.number() })),
  /** Folders with nothing in them, which Git cannot hold. */
  emptyFolders: z.array(z.string()),
});

export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;

/** Every file and empty folder under `archive`, in path order. */
export async function manifestOf(archive: string, about: string): Promise<ArchiveManifest> {
  const files: ArchiveManifest["files"] = [];
  const emptyFolders: string[] = [];

  const walk = async (relDir: string) => {
    const entries = await readdir(path.join(archive, ...relDir.split("/").filter(Boolean)), {
      withFileTypes: true,
    });

    if (entries.length === 0 && relDir !== "") {
      emptyFolders.push(relDir);
    }

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(relPath);
      } else if (entry.isFile()) {
        const stats = await stat(path.join(archive, ...relPath.split("/")));
        files.push({ path: relPath, mtimeMs: Math.trunc(stats.mtimeMs) });
      }
    }
  };

  await walk("");
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  emptyFolders.sort();

  return { about, files, emptyFolders };
}

/** Copies the archive into `target` as the manifest describes it, dates included. */
export async function copyArchive(input: {
  source: string;
  manifest: ArchiveManifest;
  target: string;
}): Promise<void> {
  for (const folder of input.manifest.emptyFolders) {
    await mkdir(path.join(input.target, ...folder.split("/")), { recursive: true });
  }

  for (const file of input.manifest.files) {
    const target = path.join(input.target, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(input.source, ...file.path.split("/")), target);
    const mtime = new Date(file.mtimeMs);
    await utimes(target, mtime, mtime);
  }
}

const FileRowSchema = z.object({
  id: z.number(),
  rel_path: z.string(),
  kind: z.string(),
  format: z.string().nullable(),
  ext_mismatch: z.number(),
  is_junk: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  frames: z.number().nullable(),
  has_alpha: z.number().nullable(),
  duration_ms: z.number().nullable(),
  video_codec: z.string().nullable(),
  audio_codec: z.string().nullable(),
  audio_streams: z.number().nullable(),
  bitrate: z.number().nullable(),
  probe_failed: z.number(),
  head_hash: z.string().nullable(),
  sha256: z.string().nullable(),
  fingerprint: z.string().nullable(),
  fingerprint_failed: z.number(),
  loudness_version: z.number(),
  loudness_max_db: z.number().nullable(),
  detail: z.instanceof(Uint8Array).nullable(),
});

const FILES_SQL = `SELECT f.id, f.rel_path, f.kind, f.format, f.ext_mismatch, f.is_junk, f.width,
    f.height, f.frames, f.has_alpha, f.duration_ms, f.video_codec, f.audio_codec,
    f.audio_streams, f.bitrate, f.probe_error IS NOT NULL AS probe_failed, f.head_hash, f.sha256,
    f.fingerprint, f.fingerprint_error IS NOT NULL AS fingerprint_failed, f.loudness_version,
    f.loudness_max_db, d.print AS detail
  FROM files f LEFT JOIN file_details d ON d.file_id = f.id
  WHERE f.root_id = $root ORDER BY f.rel_path`;

/** What a catalog row holds, by path: the scan's and every pass's results. */
function catalogFiles(catalogPath: string, rootId: number) {
  const db = new DatabaseSync(catalogPath, { readOnly: true });

  try {
    return db
      .prepare(FILES_SQL)
      .all({ $root: rootId })
      .map((row) => FileRowSchema.parse(row));
  } finally {
    db.close();
  }
}

/** A set as both reports write it: files by path, and the close-call rule applied. */
function reportSet(set: DuplicateSet, pathOf: (id: FileId) => string) {
  return {
    key: set.key.startsWith("similar:")
      ? `similar:${pathOf(FileIdSchema.parse(Number(set.key.slice("similar:".length))))}`
      : set.key,
    kind: set.kind,
    versions: set.versions.map((version) => version.files.map((file) => file.relPath)),
    pictures: set.pictures,
    keep: set.keep.map(pathOf),
    keepReason: set.keepReason,
    reclaimableBytes: set.reclaimableBytes,
    hardLinked: set.hardLinkedIds.map(pathOf),
    distance: set.distance,
    closeCall: isCloseCall(set),
  };
}

/**
 * What glazier-core made of a root: Overview's numbers, every catalog row, and at each level the
 * similar groups and the duplicate sets with their keepers, open and Spot variants' alike.
 */
export async function differentialReport(input: {
  harness: EngineHarness;
  root: Root;
  dataDir: string;
}) {
  const { harness, root } = input;
  const catalogPath = path.join(input.dataDir, "catalog.sqlite");
  const { lastScanAt: _lastScanAt, ...overview } = await harness.call("tidy", { rootId: root.id });
  const rows = catalogFiles(catalogPath, root.id);
  const paths = new Map(rows.map((row) => [row.id, row.rel_path]));

  const pathOf = (id: FileId) => {
    const found = paths.get(id);

    if (found === undefined) {
      throw new Error(`No catalog row for file ${id}`);
    }

    return found;
  };

  const db = new CatalogDatabase(catalogPath);
  const levels = [];

  try {
    for (const level of SimilarityLevelSchema.options) {
      levels.push([level, await levelReport({ harness, db, root, level, pathOf })] as const);
    }
  } finally {
    db.close();
  }

  return {
    overview,
    files: rows.map(({ id: _id, detail, ...row }) => ({
      ...row,
      detail: detail === null ? null : Buffer.from(detail).toString("hex"),
    })),
    levels: Object.fromEntries(levels),
  };
}

/** What both reports hold of a root. */
export type DifferentialReport = Awaited<ReturnType<typeof differentialReport>>;

/** At one level: the similar groups, and the open and Spot variants' sets with their keepers. */
async function levelReport(input: {
  harness: EngineHarness;
  db: CatalogDatabase;
  root: Root;
  level: SimilarityLevel;
  pathOf: (id: FileId) => string;
}) {
  const { harness, db, root, level, pathOf } = input;

  const clusters = await computeSimilarClusters(
    db,
    { rootId: root.id, level },
    async () => undefined,
  );

  const page = async (scope: "all" | "variants") =>
    harness.call("duplicateSets", {
      rootId: root.id,
      offset: 0,
      limit: 500,
      level,
      scope,
      dismissed: false,
    });

  const open = await page("all");
  const variants = await page("variants");

  return {
    groups: clusters.map((cluster) => ({
      kind: cluster.kind,
      distance: cluster.distance,
      files: cluster.ids.map(pathOf),
    })),
    counts: open.counts,
    total: open.total,
    reclaimableBytes: open.reclaimableBytes,
    openReclaimableBytes: open.openReclaimableBytes,
    fingerprinted: open.fingerprinted,
    fingerprintable: open.fingerprintable,
    compared: open.compared,
    comparable: open.comparable,
    sets: open.sets.map((set) => reportSet(set, pathOf)),
    variants: variants.sets.map((set) => reportSet(set, pathOf)),
  };
}
