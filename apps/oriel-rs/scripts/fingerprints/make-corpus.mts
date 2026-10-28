/**
 * Writes the fingerprint corpus, `apps/oriel-rs/conformance/fingerprints/corpus`: small synthetic
 * pictures covering what glazier-core's prints read differently (EXIF orientations, alpha, 16 bits,
 * CMYK, ICC profiles, each still format, animation pages, tiny and odd sizes) and near-duplicate
 * pairs for Spot variants. The corpus is committed, so run this only to change it, then make the
 * vectors again:
 *
 *   node apps/oriel-rs/scripts/fingerprints/make-corpus.mts
 *   UPDATE_FINGERPRINT_VECTORS=1 pnpm --filter @latch-works/glazier-core exec vitest run \
 *     src/similarity/fingerprint-vectors.test.ts
 *
 * The 6000×4000 still is not here: both test suites draw it at test time (`largePixel`).
 */
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const CORPUS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../conformance/fingerprints/corpus",
);

/** A deterministic hash of a pixel position, for texture that JPEG decoders round differently. */
function grain(x: number, y: number, seed: number): number {
  let value =
    Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca77) ^ Math.imul(seed, 0xc2b2ae3d);

  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  value ^= value >>> 12;

  return (value & 0xff) / 255 - 0.5;
}

interface SceneOptions {
  seed: number;
  /** Peak-to-peak grain, in levels. */
  grain?: number;
  alpha?: boolean;
  /** A dark ellipse at this share of the width and height: another face, for Spot variants. */
  spot?: { x: number; y: number; radius: number };
}

/**
 * A picture-like scene as raw RGB(A): a gradient, three soft discs, a dark band and some grain.
 * Positions are shares of the size, so one seed at two sizes shows one picture.
 */
function scene(width: number, height: number, options: SceneOptions): Buffer {
  const { seed, grain: amount = 12, alpha = false, spot } = options;
  const channels = alpha ? 4 : 3;
  const pixels = Buffer.alloc(width * height * channels);

  const discs = [0, 1, 2].map((index) => ({
    x: 0.2 + ((seed * 37 + index * 53) % 60) / 100,
    y: 0.2 + ((seed * 61 + index * 29) % 60) / 100,
    radius: 0.12 + ((seed + index) % 4) * 0.04,
    colour: [(seed * 71 + index * 90) % 256, (seed * 43 + index * 150) % 256, (index * 200) % 256],
  }));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;
      let rgb = [40 + 170 * u, 50 + 150 * v, 210 - 160 * ((u + v) / 2)];

      for (const disc of discs) {
        const distance = Math.hypot((u - disc.x) * (width / height), v - disc.y) / disc.radius;
        const cover = Math.min(1, Math.max(0, (1 - distance) * 6));
        rgb = rgb.map((value, band) => value * (1 - cover) + (disc.colour[band] ?? 0) * cover);
      }

      const band = Math.abs(v - 0.25 - u * 0.5);

      if (band < 0.04) {
        rgb = rgb.map((value) => value * 0.25);
      }

      if (spot && Math.hypot((u - spot.x) * (width / height), v - spot.y) < spot.radius) {
        rgb = [18, 30, 52];
      }

      const offset = (y * width + x) * channels;
      const noise = grain(x, y, seed) * amount;

      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(
          Math.min(255, Math.max(0, (rgb[channel] ?? 0) + noise)),
        );
      }

      if (alpha) {
        // Opaque at the left, clear at the right, with a fully clear hole.
        const hole = Math.hypot(u - 0.7, v - 0.4) < 0.12;
        pixels[offset + 3] = hole ? 0 : Math.round(255 * Math.min(1, Math.max(0, 1.2 - u)));
      }
    }
  }

  return pixels;
}

function rgb(width: number, height: number, options: SceneOptions) {
  const channels = options.alpha ? 4 : 3;

  return sharp(scene(width, height, options), { raw: { width, height, channels } });
}

/**
 * 8-bit samples spread over 16 bits, with low bits a downscale to 8 would round. sharp reads raw
 * input as 16-bit only from a Uint16Array.
 */
function widen(pixels: Buffer): Uint16Array {
  const wide = new Uint16Array(pixels.length);

  for (let index = 0; index < pixels.length; index += 1) {
    wide[index] = ((pixels[index] ?? 0) * 257 + ((index * 131) % 257)) & 0xffff;
  }

  return wide;
}

/** How libvips shows each EXIF orientation: this many clockwise quarter turns, then a mirror. */
const TURNS = {
  1: { quarterTurns: 0, mirror: false },
  2: { quarterTurns: 0, mirror: true },
  3: { quarterTurns: 2, mirror: false },
  4: { quarterTurns: 2, mirror: true },
  5: { quarterTurns: 1, mirror: true },
  6: { quarterTurns: 1, mirror: false },
  7: { quarterTurns: 3, mirror: true },
  8: { quarterTurns: 3, mirror: false },
} as const satisfies Record<number, { quarterTurns: number; mirror: boolean }>;

type Orientation = keyof typeof TURNS;

const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const satisfies readonly Orientation[];

/**
 * The pixels stored so that EXIF `orientation` shows `displayed`: libvips shows orientation N by
 * turning clockwise, then mirroring, so this undoes the mirror and then the turn.
 */
function storedFor(displayed: Buffer, width: number, height: number, orientation: Orientation) {
  const { quarterTurns, mirror } = TURNS[orientation];
  const quarter = quarterTurns % 2 === 1;
  const storedWidth = quarter ? height : width;
  const storedHeight = quarter ? width : height;
  const stored = Buffer.alloc(displayed.length);

  for (let y = 0; y < storedHeight; y += 1) {
    for (let x = 0; x < storedWidth; x += 1) {
      // Where stored (x, y) lands once turned clockwise, then mirrored.
      let [dx, dy] = [x, y];

      if (quarterTurns === 1) {
        [dx, dy] = [storedHeight - 1 - y, x];
      } else if (quarterTurns === 2) {
        [dx, dy] = [storedWidth - 1 - x, storedHeight - 1 - y];
      } else if (quarterTurns === 3) {
        [dx, dy] = [y, storedWidth - 1 - x];
      }

      if (mirror) {
        dx = width - 1 - dx;
      }

      displayed.copy(
        stored,
        (y * storedWidth + x) * 3,
        (dy * width + dx) * 3,
        (dy * width + dx + 1) * 3,
      );
    }
  }

  return { stored, storedWidth, storedHeight };
}

/** A JPEG with an EXIF segment holding only `orientation`, right after its start marker. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);

  return Buffer.concat([jpeg.subarray(0, 2), segment, payload, jpeg.subarray(2)]);
}

/** Frames of a short animation stacked top to bottom, as sharp reads raw pages. */
function animationFrames(width: number, height: number, count: number): Buffer {
  return Buffer.concat(
    Array.from({ length: count }, (_, index) =>
      scene(width, height, { seed: 20 + index * 3, grain: 0 }),
    ),
  );
}

const ANIMATION_DELAYS_MS = [0, 40, 100, 5, 250, 60];

async function main(): Promise<void> {
  await rm(CORPUS, { force: true, recursive: true });
  await mkdir(CORPUS, { recursive: true });
  const out = (name: string) => path.join(CORPUS, name);

  // EXIF orientations 1–8 of one 400×300 picture: each should look the same once turned.
  const displayed = scene(400, 300, { seed: 1 });

  for (const orientation of ORIENTATIONS) {
    const { stored, storedWidth, storedHeight } = storedFor(displayed, 400, 300, orientation);

    const jpeg = await sharp(stored, {
      raw: { width: storedWidth, height: storedHeight, channels: 3 },
    })
      .jpeg({ quality: 85 })
      .toBuffer();

    await writeFile(out(`orient-${orientation}.jpg`), withOrientation(jpeg, orientation));
  }

  await rgb(300, 200, { seed: 2, alpha: true, grain: 4 }).png().toFile(out("alpha.png"));
  await rgb(300, 200, { seed: 2, alpha: true }).webp({ quality: 80 }).toFile(out("alpha.webp"));
  await rgb(300, 200, { seed: 2, alpha: true }).avif({ quality: 55 }).toFile(out("alpha.avif"));

  await rgb(320, 240, { seed: 3, grain: 4 }).toColourspace("b-w").png().toFile(out("grey.png"));
  await rgb(320, 240, { seed: 3 })
    .toColourspace("b-w")
    .jpeg({ quality: 85 })
    .toFile(out("grey.jpg"));

  const wide = widen(scene(192, 144, { seed: 4, grain: 4 }));
  await sharp(wide, { raw: { width: 192, height: 144, channels: 3 } })
    .toColourspace("rgb16")
    .png()
    .toFile(out("rgb16.png"));
  const wideAlpha = widen(scene(192, 144, { seed: 4, alpha: true, grain: 4 }));
  await sharp(wideAlpha, { raw: { width: 192, height: 144, channels: 4 } })
    .toColourspace("rgb16")
    .png()
    .toFile(out("rgba16.png"));

  const wideGrey = widen(
    await rgb(192, 144, { seed: 5, grain: 4 }).toColourspace("b-w").raw().toBuffer(),
  );

  await sharp(wideGrey, { raw: { width: 192, height: 144, channels: 1 } })
    .toColourspace("grey16")
    .png()
    .toFile(out("grey16.png"));

  await rgb(360, 270, { seed: 6 })
    .toColourspace("cmyk")
    .jpeg({ quality: 85 })
    .toFile(out("cmyk.jpg"));
  await rgb(360, 270, { seed: 7 }).withIccProfile("p3").jpeg({ quality: 85 }).toFile(out("p3.jpg"));
  await rgb(480, 360, { seed: 8 })
    .jpeg({ quality: 80, progressive: true })
    .toFile(out("progressive.jpg"));
  await rgb(400, 300, { seed: 9 }).avif({ quality: 50 }).toFile(out("photo.avif"));
  await rgb(400, 300, { seed: 10 }).webp({ quality: 75 }).toFile(out("lossy.webp"));
  await rgb(200, 150, { seed: 11, grain: 0 }).webp({ lossless: true }).toFile(out("lossless.webp"));

  // A large JPEG, so both prints decode it shrunk by 8 on load.
  await rgb(2400, 1800, { seed: 12, grain: 0 }).jpeg({ quality: 70 }).toFile(out("large.jpg"));

  // Animations: six 96×64 pages with delays that include the browsers' 100 ms floor.
  const frames = animationFrames(96, 64, ANIMATION_DELAYS_MS.length);

  const pages = {
    raw: {
      width: 96,
      height: 64 * ANIMATION_DELAYS_MS.length,
      channels: 3 as const,
      pageHeight: 64,
    },
  };

  await sharp(frames, pages)
    .gif({ delay: ANIMATION_DELAYS_MS, loop: 0 })
    .toFile(out("animated.gif"));
  await sharp(frames, pages)
    .webp({ delay: ANIMATION_DELAYS_MS, loop: 0, quality: 80 })
    .toFile(out("animated.webp"));

  // Tiny and odd sizes.
  await rgb(1, 1, { seed: 13 }).png().toFile(out("tiny-1x1.png"));
  await rgb(7, 3, { seed: 14 }).jpeg({ quality: 90 }).toFile(out("tiny-7x3.jpg"));
  await rgb(7, 3, { seed: 14 }).png().toFile(out("tiny-7x3.png"));
  await rgb(1000, 60, { seed: 15, grain: 4 }).png().toFile(out("strip.png"));
  await rgb(90, 1100, { seed: 16 }).jpeg({ quality: 80 }).toFile(out("tall.jpg"));

  // Near-duplicate pairs: one picture re-encoded, resized and slightly cropped, and two variants.
  const base = { seed: 17, grain: 6 };
  await rgb(384, 288, base).png().toFile(out("pair-base.png"));
  await rgb(384, 288, base).jpeg({ quality: 60 }).toFile(out("pair-reencoded.jpg"));
  await rgb(384, 288, base).resize(192, 144).webp({ quality: 70 }).toFile(out("pair-resized.webp"));
  await rgb(384, 288, base)
    .extract({ left: 5, top: 3, width: 375, height: 282 })
    .jpeg({ quality: 80 })
    .toFile(out("pair-cropped.jpg"));
  await rgb(384, 288, { ...base, spot: { x: 0.3, y: 0.62, radius: 0.07 } })
    .webp({ lossless: true })
    .toFile(out("pair-face.webp"));
  await rgb(384, 288, { ...base, spot: { x: 0.8, y: 0.2, radius: 0.025 } })
    .png()
    .toFile(out("pair-spot.png"));

  // One short H.264 clip; both apps run the same ffmpeg over it.
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x120:rate=15:duration=3",
    "-vf",
    "noise=alls=12:allf=t+u:all_seed=7",
    "-c:v",
    "libx264",
    "-preset",
    "veryslow",
    "-crf",
    "32",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    out("clip.mp4"),
  ]);
}

await main();
