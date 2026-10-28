import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import {
  type ComicPageEntry,
  type FixturePlan,
  type ProfileName,
  planFixture,
  type StillEntry,
  VIDEO_CODECS,
  type VideoEntry,
} from "./plan.ts";
import { writeComicPage, writeDerivedStill, writeOriginalStill, writeVideo } from "./render.ts";

/**
 * Makes plan 063's Phase 0 fixture archive in Oriel GPUI's sandbox: 20,000 stills, 300 videos and
 * 40 comics (`--profile full`, the default), or a small archive of the same layout for a first
 * look (`--profile smoke`).
 *
 *   node apps/oriel-gpui/scripts/fixture/make-fixture.ts [--profile smoke] [--jobs 12]
 *
 * Deterministic for a seed (`--seed`), resumable (a file on disk is skipped; files appear only
 * when complete) and parallel. `manifest.json` is written last, so its presence means the
 * archive is whole.
 */

const SANDBOX = path.join(os.homedir(), ".latch-works", "oriel-gpui", "sandbox");

const DEFAULT_SEED = "oriel-gpui-063";

const { values } = parseArgs({
  options: {
    jobs: { type: "string", default: String(os.availableParallelism()) },
    out: { type: "string" },
    profile: { type: "string", default: "full" },
    seed: { type: "string", default: DEFAULT_SEED },
  },
});

function parseProfile(value: string): ProfileName {
  if (value === "full" || value === "smoke") {
    return value;
  }

  throw new Error(`Unknown profile "${value}"; use full or smoke`);
}

const profile = parseProfile(values.profile);

const jobs = Math.max(1, Number.parseInt(values.jobs, 10) || 1);

const seed = values.seed;

const outDir = path.resolve(
  values.out ??
    path.join(SANDBOX, profile === "full" ? "spike-fixture" : `spike-fixture-${profile}`),
);

// The fixture is for Oriel GPUI's sandbox; anywhere else could be someone's real archive.
if (!outDir.startsWith(`${SANDBOX}${path.sep}`) && !outDir.startsWith(os.tmpdir())) {
  throw new Error(`Refusing to write ${outDir}: outside ${SANDBOX} and the temp folder`);
}

// sharp runs each image on libuv's thread pool, which is four threads unless the variable is set
// before the pool starts, so the script starts itself again with a pool as wide as its jobs.
if (process.env.UV_THREADPOOL_SIZE === undefined) {
  const child = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    env: { ...process.env, UV_THREADPOOL_SIZE: String(jobs + 4) },
    stdio: "inherit",
  });

  process.exit(child.status ?? 1);
}

// One libvips thread per image: the parallelism comes from running `jobs` images at once.
sharp.concurrency(1);

const stagingDir = `${outDir}.staging`;

interface PhaseResult {
  made: number;
  skipped: number;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);

    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `make` for each entry whose file is missing, `width` at a time. Each file is written in
 * the staging folder, given its mtime, then renamed into place, so an interrupted run leaves no
 * partial file in the archive.
 */
async function runPhase<T extends { relPath: string; mtimeMs: number }>(
  label: string,
  entries: readonly T[],
  width: number,
  make: (entry: T, staged: string, slot: number) => Promise<void>,
): Promise<PhaseResult> {
  const started = performance.now();
  const result: PhaseResult = { made: 0, skipped: 0 };
  let next = 0;
  let lastReport = 0;

  const report = (force: boolean) => {
    const now = performance.now();

    if (!force && now - lastReport < 5000) {
      return;
    }

    lastReport = now;
    const done = result.made + result.skipped;
    const rate = result.made / Math.max(0.001, (now - started) / 1000);
    const remaining = rate > 0 ? Math.round((entries.length - done) / rate) : 0;
    console.log(
      `${label}: ${done}/${entries.length} (made ${result.made}, skipped ${result.skipped}, ` +
        `${rate.toFixed(1)}/s, about ${Math.ceil(remaining / 60)} min left)`,
    );
  };

  const worker = async (slot: number) => {
    for (;;) {
      const entry = entries[next];
      next += 1;

      if (!entry) {
        return;
      }

      const target = path.join(outDir, entry.relPath);

      if (await exists(target)) {
        result.skipped += 1;
      } else {
        const staged = path.join(stagingDir, `${slot}-${entry.relPath.replaceAll("/", "__")}`);
        await make(entry, staged, slot);
        const mtime = new Date(entry.mtimeMs);
        await utimes(staged, mtime, mtime);
        await mkdir(path.dirname(target), { recursive: true });
        await rename(staged, target);
        result.made += 1;
      }

      report(false);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(width, entries.length) }, (_, slot) => worker(slot)),
  );
  report(true);

  return result;
}

interface Range {
  min: number;
  max: number;
}

function rangeOf(numbers: readonly number[]): Range | null {
  if (numbers.length === 0) {
    return null;
  }

  return { min: Math.min(...numbers), max: Math.max(...numbers) };
}

function countBy<T>(items: readonly T[], key: (item: T) => string) {
  const counts = new Map<string, number>();

  for (const item of items) {
    const name = key(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return Object.fromEntries(counts);
}

async function bytesOf(entries: readonly { relPath: string }[]): Promise<number> {
  let total = 0;

  for (const entry of entries) {
    total += (await stat(path.join(outDir, entry.relPath))).size;
  }

  return total;
}

/** Every regular file under the archive, relative, to check nothing is missing or extra. */
async function listFiles(): Promise<string[]> {
  const entries = await readdir(outDir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(outDir, path.join(entry.parentPath, entry.name)));
}

function toolVersions() {
  const ffmpeg = execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0] ?? "";

  return {
    node: process.version,
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
    aom: sharp.versions.aom ?? null,
    ffmpeg,
  };
}

async function writeManifest(
  plan: FixturePlan,
  run: { startedAt: Date; made: number; skipped: number },
): Promise<void> {
  const stillBytes = await bytesOf(plan.stills);
  const videoBytes = await bytesOf(plan.videos);
  const comicBytes = await bytesOf(plan.comicPages);
  const files = await listFiles();

  const planned = new Set(
    [...plan.stills, ...plan.videos, ...plan.comicPages].map((entry) => entry.relPath),
  );

  const unexpected = files.filter((file) => !planned.has(file) && file !== "manifest.json");

  if (unexpected.length > 0 || files.length < planned.size) {
    throw new Error(
      `The archive does not match its plan: ${files.length} files for ${planned.size} planned, ` +
        `unexpected: ${unexpected.slice(0, 5).join(", ")}`,
    );
  }

  const longEdges = plan.stills.map((still) => Math.max(still.width, still.height));
  const megapixels = plan.stills.map((still) => (still.width * still.height) / 1e6);

  const videosByCodec = Object.fromEntries(
    await Promise.all(
      VIDEO_CODECS.map(async (codec) => {
        const videos = plan.videos.filter((video) => video.codec === codec);

        return [
          codec,
          {
            count: videos.length,
            bytes: await bytesOf(videos),
            encoder: { av1: "libsvtav1", h264: "libx264", hevc: "libx265 (hvc1)" }[codec],
          },
        ];
      }),
    ),
  );

  const finishedAt = new Date();

  const manifest = {
    name: "Oriel GPUI spike fixture (plan 063, Phase 0)",
    profile: plan.profile,
    seed: plan.seed,
    layout: {
      stills: "stills/Roll <n>/<camera-style name>.{jpg,JPG,jpeg,avif}",
      videos: "videos/<h264|hevc|av1>/VID_<n>.mp4",
      comics: "comics/<Title>-<n>/<page> and comics/<Series>_Saga/Vol_<n>/<page>",
    },
    counts: {
      files: planned.size,
      stills: plan.stills.length,
      stillsByFormat: countBy(plan.stills, (still) => still.format),
      stillsByExtension: countBy(plan.stills, (still) => path.extname(still.relPath)),
      stillFolders: new Set(plan.stills.map((still) => still.folder)).size,
      stillsRotatedByExif: plan.stills.filter((still) => still.rotated).length,
      derivedStills: countBy(
        plan.stills.filter((still) => still.derived),
        (still) => still.derived?.kind ?? "",
      ),
      videos: plan.videos.length,
      videosByCodec: countBy(plan.videos, (video) => video.codec),
      comics: plan.comics.length,
      comicPages: plan.comicPages.length,
      comicPagesByFormat: countBy(plan.comicPages, (page) => page.format),
    },
    bytes: {
      total: stillBytes + videoBytes + comicBytes,
      stills: stillBytes,
      videos: videoBytes,
      comics: comicBytes,
    },
    stills: {
      longEdge: rangeOf(longEdges),
      megapixels: rangeOf(megapixels),
      meanMegapixels: megapixels.reduce((sum, value) => sum + value, 0) / megapixels.length,
      orientation: countBy(plan.stills, (still) =>
        still.width >= still.height ? "landscape" : "portrait",
      ),
      jpeg: "sharp (libjpeg) quality 90, 4:2:0; re-encodes 75",
      avif: "sharp (libheif + aom) quality 70, effort 2, 4:2:0, 8-bit; re-encodes 50",
    },
    videos: {
      codecs: videosByCodec,
      audio: "AAC 128 kb/s stereo, a sine tone",
      container: "MP4, faststart",
      sizes: countBy(plan.videos, (video) => `${video.width}x${video.height}`),
      fps: countBy(plan.videos, (video) => String(video.fps)),
      seconds: rangeOf(plan.videos.map((video) => video.seconds)),
      totalSeconds: plan.videos.reduce((sum, video) => sum + video.seconds, 0),
    },
    comics: {
      folders: plan.comics,
      pagesPerComic: rangeOf(Object.values(countBy(plan.comicPages, (page) => page.comic))),
      pageWidth: rangeOf(plan.comicPages.map((page) => page.width)),
      pageHeight: rangeOf(plan.comicPages.map((page) => page.height)),
    },
    duplicates: plan.stills.flatMap((still) =>
      still.derived
        ? [{ path: still.relPath, kind: still.derived.kind, of: still.derived.from }]
        : [],
    ),
    generation: {
      startedAt: run.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      seconds: Math.round((finishedAt.getTime() - run.startedAt.getTime()) / 1000),
      filesMade: run.made,
      filesSkipped: run.skipped,
      note: "seconds is this run's; a resumed run skips the files earlier runs made",
      jobs,
      cores: os.availableParallelism(),
      tools: toolVersions(),
    },
  };

  const staged = path.join(stagingDir, "manifest.json");
  await writeFile(staged, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(staged, path.join(outDir, "manifest.json"));
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const plan = planFixture(profile, seed);
  console.log(
    `Fixture "${profile}" at ${outDir}: ${plan.stills.length} stills, ${plan.videos.length} ` +
      `videos, ${plan.comics.length} comics (${plan.comicPages.length} pages); ${jobs} jobs`,
  );

  // A manifest describes a whole archive, so it goes before anything changes.
  await rm(path.join(outDir, "manifest.json"), { force: true });
  await rm(stagingDir, { force: true, recursive: true });
  await mkdir(stagingDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const originals = plan.stills.filter((still) => !still.derived);
  const derived = plan.stills.filter((still) => still.derived);
  const results: PhaseResult[] = [];

  results.push(
    await runPhase<StillEntry>("stills", originals, jobs, (entry, staged) =>
      writeOriginalStill(seed, entry, staged),
    ),
  );
  results.push(
    await runPhase<StillEntry>("duplicates", derived, jobs, (entry, staged) =>
      writeDerivedStill(entry, path.join(outDir, entry.derived?.from ?? ""), staged),
    ),
  );
  results.push(
    await runPhase<ComicPageEntry>("comic pages", plan.comicPages, jobs, (entry, staged) =>
      writeComicPage(seed, entry, staged),
    ),
  );

  // ffmpeg threads within a clip; run a third as many clips, three threads each.
  const videoWidth = Math.max(1, Math.ceil(jobs / 3));
  results.push(
    await runPhase<VideoEntry>("videos", plan.videos, videoWidth, (entry, staged, slot) =>
      writeVideo(entry, staged, path.join(stagingDir, `label-${slot}.png`), 3),
    ),
  );

  const made = results.reduce((sum, result) => sum + result.made, 0);
  const skipped = results.reduce((sum, result) => sum + result.skipped, 0);
  await writeManifest(plan, { startedAt, made, skipped });
  await rm(stagingDir, { force: true, recursive: true });

  const seconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  console.log(`Done in ${seconds} s: made ${made}, skipped ${skipped}. ${outDir}/manifest.json`);
}

await main();
