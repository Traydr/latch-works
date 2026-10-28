import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import sharp from "sharp";
import type { EngineEvent } from "../../../../packages/glazier-core/src/contract.ts";
import { GlazierEngine } from "../../../../packages/glazier-core/src/engine/engine.ts";
import { forEachConcurrent } from "../../../../packages/glazier-core/src/passes/context.ts";
import { hashWholeFile } from "../../../../packages/glazier-core/src/passes/hash-pass.ts";
import { type WalkedFile, walkRoot } from "../../../../packages/glazier-core/src/scan/walk.ts";
import {
  ARCHIVE_AVIF_OPTIONS,
  ARCHIVE_AVIF_SHARP_OPTIONS,
  type AvifCodec,
  createArchiveAvifEncoder,
} from "../../../../packages/media-format/src/avif.ts";
import { planFixture } from "./plan.ts";

/**
 * The TypeScript side of plan 063's Phase 0 measurements, on `glazier-core`'s real code. Run it
 * with e2e's tsx, which resolves the packages' `.js` imports to their sources. tsx runs from
 * `e2e/`, so the script's path is absolute:
 *
 *   pnpm --filter @latch-works/e2e exec tsx $PWD/apps/oriel-rs/scripts/fixture/bench-glazier.mts \
 *     walk <root>
 *   … hash-all <root> [--concurrency 4]   SHA-256 of every file, as hashWholeFile reads it
 *   … engine-scan <root>                  the engine's whole scan job, in a temporary catalog
 *   … avif-prepare <fixture> <out>        20 JPEGs decoded as Tidy does, then encoded by the wasm
 *                                         encoder and by sharp; RGBA kept for avif-bench
 *   … avif-quality <out>                  SSIM and PSNR of each encode against its source
 *
 * Every command prints JSON lines; runs repeat `--runs` times (3) and end with the median.
 */

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    concurrency: { type: "string", default: "4" },
    runs: { type: "string", default: "3" },
  },
});

const [command, firstPath, secondPath] = positionals;

const runs = Number.parseInt(values.runs, 10);

function median(numbers: readonly number[]): number {
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function print(record: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify(record));
}

async function listFiles(root: string): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  await walkRoot({ rootPath: root, onBatch: (batch) => files.push(...batch) });

  return files;
}

async function benchWalk(root: string): Promise<void> {
  const rates: number[] = [];

  for (let run = 1; run <= runs; run += 1) {
    const started = performance.now();
    const summary = await walkRoot({ rootPath: root, onBatch: () => {} });
    const seconds = (performance.now() - started) / 1000;
    rates.push(summary.files / seconds);
    print({
      kind: "walk",
      run,
      files: summary.files,
      seconds,
      filesPerSecond: summary.files / seconds,
    });
  }

  print({ kind: "walk-median", filesPerSecond: median(rates) });
}

/** `hashWholeFile` over every file, `concurrency` at a time, as the pass's second step runs. */
async function benchHashAll(root: string): Promise<void> {
  const concurrency = Number.parseInt(values.concurrency, 10);
  const files = await listFiles(root);
  const signal = new AbortController().signal;
  const fileRates: number[] = [];
  const byteRates: number[] = [];

  for (let run = 1; run <= runs; run += 1) {
    let bytes = 0;
    const started = performance.now();

    await forEachConcurrent(
      files,
      concurrency,
      async () => {},
      async (file) => {
        await hashWholeFile(
          path.join(root, file.relPath),
          { size: file.size, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs },
          signal,
        );
        bytes += file.size;
      },
    );

    const seconds = (performance.now() - started) / 1000;
    fileRates.push(files.length / seconds);
    byteRates.push(bytes / 1e6 / seconds);
    print({
      kind: "hash-all",
      run,
      concurrency,
      files: files.length,
      bytes,
      seconds,
      filesPerSecond: files.length / seconds,
      megabytesPerSecond: bytes / 1e6 / seconds,
    });
  }

  print({
    kind: "hash-all-median",
    concurrency,
    filesPerSecond: median(fileRates),
    megabytesPerSecond: median(byteRates),
  });
}

function findTool(name: string): Promise<string | null> {
  return execFileAsync("which", [name]).then(
    ({ stdout }) => stdout.trim() || null,
    () => null,
  );
}

/**
 * The engine's scan job as Tidy runs it when a root is added: walk into the catalog, identify
 * formats, read media details (ffprobe for videos), hash possible duplicates. Each run uses a
 * fresh catalog in the temp folder; the background analysis queued after it is cancelled.
 */
async function benchEngineScan(root: string): Promise<void> {
  const toolkit = {
    sharp,
    ffmpegPath: await findTool("ffmpeg"),
    ffprobePath: await findTool("ffprobe"),
  };

  const seconds: number[] = [];

  for (let run = 1; run <= runs; run += 1) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "oriel-rs-bench-glazier-"));
    const phases = new Map<string, { first: number; last: number }>();
    let started = 0;
    let finish: (value: number) => void = () => {};

    const finished = new Promise<number>((resolve) => {
      finish = resolve;
    });

    const emit = (event: EngineEvent) => {
      if (event.kind !== "job" || event.job.type !== "scan") {
        return;
      }

      const now = performance.now();
      // Progress reaches the job as its message: "Walking …", "Identifying formats", …
      const label = event.job.message ?? event.job.state;
      const phase = phases.get(label);
      phases.set(label, { first: phase?.first ?? now, last: now });

      if (event.job.state === "done" || event.job.state === "failed") {
        finish(now);
      }
    };

    const engine = await GlazierEngine.open({
      dataDir,
      toolkit,
      stillEncoder: {
        encode: () => Promise.reject(new Error("No encodes while measuring a scan")),
      },
      transcoder: {
        transcode: () => Promise.reject(new Error("No transcodes while measuring a scan")),
      },
      stillConcurrency: 2,
      emit,
    });

    started = performance.now();
    await engine.dispatch("addRoot", { path: root });
    const ended = await finished;
    engine.close();
    await rm(dataDir, { force: true, recursive: true });

    seconds.push((ended - started) / 1000);
    print({ kind: "engine-scan", run, seconds: (ended - started) / 1000 });

    for (const [label, phase] of phases) {
      print({
        kind: "engine-scan-phase",
        run,
        label: label.replace(root, "<root>"),
        fromStart: (phase.first - started) / 1000,
        lastSeen: (phase.last - started) / 1000,
      });
    }
  }

  print({ kind: "engine-scan-median", seconds: median(seconds) });
}

/**
 * 20 JPEG originals of the fixture, two of each camera size and two stored turned by EXIF, picked
 * from the plan so the choice does not depend on the disk.
 */
function avifSample(): string[] {
  const plan = planFixture("full", "oriel-rs-063");
  const jpegs = plan.stills.filter((still) => still.format === "jpeg" && !still.derived);
  const picked: string[] = [];
  const perSize = new Map<string, number>();

  for (const still of jpegs.filter((entry) => entry.rotated).slice(0, 2)) {
    picked.push(still.relPath);
  }

  for (const still of jpegs) {
    const size = `${Math.max(still.width, still.height)}x${Math.min(still.width, still.height)}`;
    const count = perSize.get(size) ?? 0;

    if (count < 2 && !still.rotated && picked.length < 20) {
      perSize.set(size, count + 1);
      picked.push(still.relPath);
    }
  }

  return picked;
}

async function loadWasmCodec(): Promise<AvifCodec> {
  // @jsquash/avif is glazier-core's dependency, so it resolves from that package.
  const require = createRequire(path.join(REPO_ROOT, "packages/glazier-core/package.json"));
  const modulePath = require.resolve("@jsquash/avif/codec/enc/avif_enc.js");
  const { default: createAvifEncoder } = await import(modulePath);

  return createAvifEncoder({
    wasmBinary: await readFile(require.resolve("@jsquash/avif/codec/enc/avif_enc.wasm")),
    noInitialRun: true,
  });
}

/**
 * Decodes each sample as `encodeStillToAvif` does (EXIF orientation applied, sRGB, RGBA), times
 * the wasm encoder on it at `ARCHIVE_AVIF_OPTIONS` and sharp at `ARCHIVE_AVIF_SHARP_OPTIONS`, and
 * keeps the RGBA so `avif-bench` encodes exactly the same pixels.
 */
async function avifPrepare(fixture: string, out: string): Promise<void> {
  const encodeRgba = createArchiveAvifEncoder(loadWasmCodec);
  const sample = avifSample();
  await mkdir(path.join(out, "rgba"), { recursive: true });
  await mkdir(path.join(out, "wasm"), { recursive: true });
  await mkdir(path.join(out, "sharp"), { recursive: true });
  const list: { name: string; source: string; width: number; height: number }[] = [];

  // One warm-up encode, so the first sample does not pay for compiling the module.
  await encodeRgba({ data: new Uint8Array(64 * 64 * 4), width: 64, height: 64 });

  for (const [index, relPath] of sample.entries()) {
    const name = `${String(index + 1).padStart(2, "0")}`;
    const source = path.join(fixture, relPath);
    const decodeStarted = performance.now();

    const { data, info } = await sharp(source, { failOn: "none", limitInputPixels: false })
      .rotate()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw({ depth: "uchar" })
      .toBuffer({ resolveWithObject: true });

    const decodeMs = performance.now() - decodeStarted;
    await writeFile(path.join(out, "rgba", `${name}.rgba`), data);

    const wasmStarted = performance.now();

    const encoded = await encodeRgba({
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    });

    const wasmMs = performance.now() - wasmStarted;
    await writeFile(path.join(out, "wasm", `${name}.avif`), new Uint8Array(encoded));

    const sharpStarted = performance.now();

    const sharpInfo = await sharp(source)
      .rotate()
      .toColourspace("srgb")
      .avif(ARCHIVE_AVIF_SHARP_OPTIONS)
      .toFile(path.join(out, "sharp", `${name}.avif`));

    const sharpMs = performance.now() - sharpStarted;

    list.push({ name, source, width: info.width, height: info.height });
    print({
      kind: "avif-ts",
      name,
      width: info.width,
      height: info.height,
      sourceBytes: (await stat(source)).size,
      decodeMs,
      wasmBytes: encoded.byteLength,
      wasmMs,
      sharpBytes: sharpInfo.size,
      sharpMs,
    });
  }

  await writeFile(path.join(out, "list.json"), `${JSON.stringify(list, null, 2)}\n`);
  await writeFile(
    path.join(out, "settings.json"),
    `${JSON.stringify({ wasm: ARCHIVE_AVIF_OPTIONS, sharp: ARCHIVE_AVIF_SHARP_OPTIONS }, null, 2)}\n`,
  );
}

const SSIM_ALL = /All:([\d.]+)/;

const PSNR_AVERAGE = /average:([\d.]+|inf)/;

/** SSIM and PSNR of `candidate` against `reference`, both PNG, on 8-bit 4:4:4 YUV. */
async function compare(
  reference: string,
  candidate: string,
): Promise<{ ssim: number; psnr: number }> {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    candidate,
    "-i",
    reference,
    "-lavfi",
    "[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim;[0:v]format=yuv444p[c];[1:v]format=yuv444p[d];[c][d]psnr",
    "-f",
    "null",
    "-",
  ]).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }));

  return {
    ssim: Number(SSIM_ALL.exec(stderr)?.[1] ?? Number.NaN),
    psnr: Number(PSNR_AVERAGE.exec(stderr)?.[1] ?? Number.NaN),
  };
}

/** Decodes the source and every encode to PNG with sharp, then compares each with the source. */
async function avifQuality(out: string): Promise<void> {
  const list: { name: string; source: string }[] = JSON.parse(
    await readFile(path.join(out, "list.json"), "utf8"),
  );

  // Every folder of encodes: wasm, sharp, and avif-bench's rust-t<threads>.
  const encoders = (await readdir(out, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !["png", "rgba"].includes(entry.name))
    .map((entry) => entry.name)
    .sort();

  const pngDir = path.join(out, "png");
  await mkdir(pngDir, { recursive: true });

  for (const { name, source } of list) {
    const reference = path.join(pngDir, `${name}-source.png`);
    await sharp(source)
      .rotate()
      .toColourspace("srgb")
      .png({ compressionLevel: 1 })
      .toFile(reference);

    for (const encoder of encoders) {
      const encoded = path.join(out, encoder, `${name}.avif`);
      const decoded = path.join(pngDir, `${name}-${encoder}.png`);

      const exists = await stat(encoded).then(
        () => true,
        () => false,
      );

      if (!exists) {
        continue;
      }

      await sharp(encoded).toColourspace("srgb").png({ compressionLevel: 1 }).toFile(decoded);
      const { ssim, psnr } = await compare(reference, decoded);
      print({ kind: "avif-quality", name, encoder, bytes: (await stat(encoded)).size, ssim, psnr });
    }
  }
}

if (!command || !firstPath) {
  throw new Error(
    "usage: bench-glazier.mts <walk|hash-all|engine-scan|avif-prepare|avif-quality> <path>",
  );
}

if (command === "walk") {
  await benchWalk(firstPath);
} else if (command === "hash-all") {
  await benchHashAll(firstPath);
} else if (command === "engine-scan") {
  await benchEngineScan(firstPath);
} else if (command === "avif-prepare") {
  await avifPrepare(firstPath, secondPath ?? "/tmp/oriel-rs-phase0/avif");
} else if (command === "avif-quality") {
  await avifQuality(firstPath);
} else {
  throw new Error(`Unknown command ${command}`);
}
