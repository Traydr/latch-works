import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { probeImage } from "../media/image-probe.js";
import { detailOfStill, isVariant, normalizeDetail } from "./detail.js";
import {
  animationFrameTimes,
  fingerprintAnimation,
  fingerprintStill,
  fingerprintVideo,
  formatFingerprint,
  greyPixels,
} from "./fingerprint.js";
import { formatHash, hammingDistance, PHASH_INPUT_SIZE, perceptualHash } from "./phash.js";

/**
 * Oriel GPUI's fingerprints must equal these bit for bit, since Spot variants' thresholds were
 * measured on prints made this way (plan 063). This checks that glazier-core still makes the
 * committed vectors; `cargo test -p oriel-core-tidy` checks that Rust does. After a deliberate
 * change here, or a sharp upgrade, make them again with UPDATE_FINGERPRINT_VECTORS=1.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const CONFORMANCE = path.join(REPO, "apps/oriel-gpui/conformance/fingerprints");

const CORPUS = path.join(CONFORMANCE, "corpus");

const VECTORS = path.join(CONFORMANCE, "vectors.json");

const UPDATE = process.env.UPDATE_FINGERPRINT_VECTORS === "1";

const STILLS = [
  "orient-1.jpg",
  "orient-2.jpg",
  "orient-3.jpg",
  "orient-4.jpg",
  "orient-5.jpg",
  "orient-6.jpg",
  "orient-7.jpg",
  "orient-8.jpg",
  "alpha.png",
  "alpha.webp",
  "alpha.avif",
  "grey.png",
  "grey.jpg",
  "rgb16.png",
  "rgba16.png",
  "grey16.png",
  "cmyk.jpg",
  "p3.jpg",
  "progressive.jpg",
  "photo.avif",
  "lossy.webp",
  "lossless.webp",
  "large.jpg",
  "tiny-1x1.png",
  "tiny-7x3.jpg",
  "tiny-7x3.png",
  "strip.png",
  "tall.jpg",
  "pair-base.png",
  "pair-reencoded.jpg",
  "pair-resized.webp",
  "pair-cropped.jpg",
  "pair-face.webp",
  "pair-spot.png",
];

const ANIMATIONS = ["animated.gif", "animated.webp"];

/** Made by make-corpus.mts as three seconds; the catalog's probe would say the same. */
const VIDEOS = [{ file: "clip.mp4", durationMs: 3000 }];

const PAIRS: Array<[string, string]> = [
  ["pair-base.png", "pair-reencoded.jpg"],
  ["pair-base.png", "pair-resized.webp"],
  ["pair-base.png", "pair-cropped.jpg"],
  ["pair-base.png", "pair-face.webp"],
  ["pair-base.png", "pair-spot.png"],
  ["pair-reencoded.jpg", "pair-resized.webp"],
  ["orient-1.jpg", "orient-2.jpg"],
  ["orient-1.jpg", "orient-3.jpg"],
  ["orient-1.jpg", "orient-4.jpg"],
  ["orient-1.jpg", "orient-5.jpg"],
  ["orient-1.jpg", "orient-6.jpg"],
  ["orient-1.jpg", "orient-7.jpg"],
  ["orient-1.jpg", "orient-8.jpg"],
  ["alpha.png", "alpha.webp"],
  ["alpha.png", "alpha.avif"],
  ["grey.png", "grey.jpg"],
];

/** The still both suites draw at test time rather than commit; Rust draws it the same way. */
const LARGE = { name: "large-6000x4000", width: 6000, height: 4000 } as const;

/** What `probeImage` reads; the similar-set search bins pictures by its aspect ratio. */
const ProbeSchema = z.object({
  width: z.number(),
  height: z.number(),
  frames: z.number(),
  hasAlpha: z.boolean(),
  frameDelaysMs: z.array(z.number()),
});

const StillVectorSchema = z.object({
  file: z.string(),
  probe: ProbeSchema,
  fingerprint: z.string(),
  /** The 32×32 grey pixels the hash reads, as hex. */
  grey32: z.string(),
  /** The 64×64 detail print, as hex. */
  detail: z.string(),
});

const VectorsSchema = z.object({
  about: z.string(),
  sharp: z.string(),
  libvips: z.string(),
  phash: z.array(z.object({ name: z.string(), pixels: z.string(), hash: z.string() })),
  stills: z.array(StillVectorSchema),
  drawn: z.array(
    StillVectorSchema.omit({ file: true, probe: true }).extend({
      name: z.string(),
      width: z.number(),
      height: z.number(),
    }),
  ),
  animations: z.array(
    z.object({
      file: z.string(),
      probe: ProbeSchema,
      frameTimesMs: z.array(z.number()),
      fingerprint: z.string(),
    }),
  ),
  videos: z.array(z.object({ file: z.string(), durationMs: z.number(), fingerprint: z.string() })),
  pairs: z.array(
    z.object({ left: z.string(), right: z.string(), distance: z.number(), variant: z.boolean() }),
  ),
});

type Vectors = z.infer<typeof VectorsSchema>;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Synthetic 32×32 inputs for the hash alone, including a flat one whose DCT is rounding noise. */
function phashInputs(): Array<{ name: string; pixels: Uint8Array }> {
  const side = PHASH_INPUT_SIZE;

  const make = (pixel: (x: number, y: number) => number) => {
    const pixels = new Uint8Array(side * side);

    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        pixels[y * side + x] = pixel(x, y) & 0xff;
      }
    }

    return pixels;
  };

  let state = 12345;

  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;

    return state >>> 24;
  };

  return [
    { name: "flat", pixels: make(() => 128) },
    { name: "ramp", pixels: make((x, y) => x * 8 + y) },
    { name: "checker", pixels: make((x, y) => (((x >> 2) + (y >> 2)) & 1) * 255) },
    { name: "disc", pixels: make((x, y) => ((x - 11) ** 2 + (y - 19) ** 2 < 64 ? 240 : 30)) },
    { name: "noise", pixels: make(() => next()) },
  ];
}

/**
 * The large still's pixels: integer arithmetic only, so Rust draws the same bytes. A gradient, a
 * checkerboard of 750×500 tiles and a disc.
 */
function drawLarge(): Buffer {
  const { width, height } = LARGE;
  const pixels = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const red = Math.floor((x * 255) / (width - 1));
      const green = Math.floor((y * 255) / (height - 1));
      const disc = (x - 3600) ** 2 + (y - 1700) ** 2 < 900 * 900;
      const tile = (Math.floor(x / 750) + Math.floor(y / 500)) % 2 === 1;
      const offset = (y * width + x) * 3;
      pixels[offset] = disc ? 255 - red : red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = disc ? 230 : tile ? 150 : 40;
    }
  }

  return pixels;
}

/** ffmpeg from PATH, as the engine harness finds it, or null. */
function findFfmpeg(): string | null {
  try {
    return execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "glazier-fingerprint-vectors-"));
});

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true });
});

async function stillVector(filePath: string) {
  return {
    fingerprint: formatFingerprint(await fingerprintStill(sharp, filePath)),
    grey32: hex(await greyPixels(sharp, filePath, { size: PHASH_INPUT_SIZE })),
    detail: hex(await detailOfStill(sharp, filePath)),
  };
}

async function makeVectors(ffmpegPath: string | null): Promise<Vectors> {
  const stills = [];

  for (const file of STILLS) {
    const filePath = path.join(CORPUS, file);
    stills.push({
      file,
      probe: await probeImage(sharp, filePath),
      ...(await stillVector(filePath)),
    });
  }

  const largePath = path.join(scratch, `${LARGE.name}.png`);
  await sharp(drawLarge(), { raw: { width: LARGE.width, height: LARGE.height, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toFile(largePath);

  const animations = [];

  for (const file of ANIMATIONS) {
    const filePath = path.join(CORPUS, file);
    const probe = await probeImage(sharp, filePath);
    const frameTimesMs = animationFrameTimes(probe.frameDelaysMs, probe.frames);
    const fingerprint = await fingerprintAnimation(sharp, filePath, frameTimesMs);
    animations.push({
      file,
      probe,
      frameTimesMs,
      fingerprint: formatFingerprint(fingerprint),
    });
  }

  const videos = [];

  for (const video of VIDEOS) {
    if (ffmpegPath === null) {
      break;
    }

    const fingerprint = await fingerprintVideo(
      ffmpegPath,
      path.join(CORPUS, video.file),
      video.durationMs,
    );

    videos.push({ ...video, fingerprint: formatFingerprint(fingerprint) });
  }

  const byFile = new Map(stills.map((still) => [still.file, still]));

  const pairs = PAIRS.map(([left, right]) => {
    const leftVector = byFile.get(left);
    const rightVector = byFile.get(right);

    if (!leftVector || !rightVector) {
      throw new Error(`A pair names a file outside the corpus: ${left}, ${right}`);
    }

    const leftHash = perceptualHash(Buffer.from(leftVector.grey32, "hex"));
    const rightHash = perceptualHash(Buffer.from(rightVector.grey32, "hex"));

    return {
      left,
      right,
      distance: hammingDistance(leftHash, rightHash),
      variant: isVariant(
        normalizeDetail(Buffer.from(leftVector.detail, "hex")),
        normalizeDetail(Buffer.from(rightVector.detail, "hex")),
      ),
    };
  });

  return {
    about:
      "Fingerprints glazier-core makes of the corpus beside this file, for Oriel GPUI to match bit " +
      "for bit (plan 063). Hex strings are raw bytes; `drawn` stills are drawn at test time; videos " +
      "go through the ffmpeg on PATH. Made by packages/glazier-core/src/similarity/" +
      "fingerprint-vectors.test.ts with UPDATE_FINGERPRINT_VECTORS=1.",
    sharp: sharp.versions.sharp ?? "unknown",
    libvips: sharp.versions.vips,
    phash: phashInputs().map(({ name, pixels }) => ({
      name,
      pixels: hex(pixels),
      hash: formatHash(perceptualHash(pixels)),
    })),
    stills,
    drawn: [
      {
        name: LARGE.name,
        width: LARGE.width,
        height: LARGE.height,
        ...(await stillVector(largePath)),
      },
    ],
    animations,
    videos,
    pairs,
  };
}

async function writeVectors(vectors: Vectors): Promise<void> {
  await writeFile(VECTORS, `${JSON.stringify(vectors, null, 2)}\n`);
  // The repository's formatter owns the file's layout; the comparison below reads it parsed.
  execFileSync(path.join(REPO, "node_modules/.bin/biome"), ["format", "--write", VECTORS], {
    stdio: "ignore",
  });
}

describe("fingerprint conformance vectors", () => {
  it("are what glazier-core makes of the corpus today", async () => {
    const ffmpegPath = findFfmpeg();

    if (UPDATE && ffmpegPath === null) {
      throw new Error("Making the vectors needs ffmpeg on PATH for the video vector.");
    }

    const actual = await makeVectors(ffmpegPath);

    if (UPDATE) {
      await writeVectors(actual);
    }

    const expected = VectorsSchema.parse(JSON.parse(await readFile(VECTORS, "utf8")));

    expect({ sharp: actual.sharp, libvips: actual.libvips }).toEqual({
      sharp: expected.sharp,
      libvips: expected.libvips,
    });
    expect(actual.phash).toEqual(expected.phash);
    expect(actual.stills).toEqual(expected.stills);
    expect(actual.drawn).toEqual(expected.drawn);
    expect(actual.animations).toEqual(expected.animations);
    expect(actual.pairs).toEqual(expected.pairs);

    if (ffmpegPath !== null) {
      expect(actual.videos).toEqual(expected.videos);
    }
  }, 120_000);
});
