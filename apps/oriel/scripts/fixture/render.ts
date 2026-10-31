import { execFile } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { promisify } from "node:util";
import sharp from "sharp";
import type { ComicPageEntry, StillEntry, StillFormat, VideoEntry } from "./plan.ts";
import { type Random, seededRandom } from "./random.ts";

const execFileAsync = promisify(execFile);

/** JPEG quality for originals, about a camera's "fine" setting. */
const JPEG_QUALITY = 90;

/**
 * AVIFs as Tidy writes them for the largest stills (`ARCHIVE_AVIF_SHARP_OPTIONS`: quality 70,
 * 4:2:0, 8-bit), but at effort 2 rather than 3, which makes 10k camera-sized AVIFs in minutes
 * rather than hours. Decoders see the same kind of file.
 */
const AVIF_OPTIONS = { bitdepth: 8, chromaSubsampling: "4:2:0", effort: 2, quality: 70 } as const;

/** Re-encodes for near-duplicates use a visibly different quality. */
const REENCODE_JPEG_QUALITY = 75;

const REENCODE_AVIF_QUALITY = 50;

const NOISE_TILE = 510;

const noiseTiles = new Map<number, Promise<Buffer>>();

/**
 * Sensor-like grain: an RGB tile of per-channel noise around mid-grey, drawn at half size and
 * enlarged so each grain is about two pixels, then soft-lit over the picture. Grain is what makes
 * a photo cost bytes; at this strength a 12-megapixel still is about 2 MB as JPEG and half that
 * as AVIF, as a camera's would roughly be. Eight seeded tiles are shared.
 */
function noiseTile(seed: string, variant: number): Promise<Buffer> {
  const cached = noiseTiles.get(variant);

  if (cached) {
    return cached;
  }

  const random = seededRandom(seed, `noise:${variant}`);
  const half = NOISE_TILE / 2;
  const grain = Buffer.alloc(half * half * 3);

  for (let offset = 0; offset < grain.length; offset += 1) {
    grain[offset] = 106 + random.int(0, 44);
  }

  const tile = sharp(grain, { raw: { width: half, height: half, channels: 3 } })
    .resize(NOISE_TILE, NOISE_TILE, { kernel: "cubic" })
    .raw()
    .toBuffer();

  noiseTiles.set(variant, tile);

  return tile;
}

function hsl(random: Random, saturation = 60, lightness = 50): string {
  return `hsl(${random.int(0, 359)}, ${saturation}%, ${lightness}%)`;
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Gradients, translucent figures and the still's number, different for every label. */
function stillSvg(seed: string, entry: StillEntry): string {
  const random = seededRandom(seed, `art:${entry.label}`);
  const { width, height } = entry;
  const corners = [random.int(0, 1), random.int(0, 1)];
  const figures: string[] = [];
  const count = random.int(5, 12);

  for (let index = 0; index < count; index += 1) {
    const x = random.int(0, width);
    const y = random.int(0, height);
    const size = random.int(Math.round(height * 0.08), Math.round(height * 0.45));
    const fill = `fill="${hsl(random, 70, random.int(30, 70))}" fill-opacity="${(0.35 + random.next() * 0.5).toFixed(2)}"`;
    const kind = random.int(0, 3);

    if (kind === 0) {
      figures.push(`<circle cx="${x}" cy="${y}" r="${size}" ${fill}/>`);
    } else if (kind === 1) {
      const angle = random.int(0, 89);
      figures.push(
        `<rect x="${x}" y="${y}" width="${size * 1.6}" height="${size}" ${fill} transform="rotate(${angle} ${x} ${y})"/>`,
      );
    } else if (kind === 2) {
      figures.push(`<ellipse cx="${x}" cy="${y}" rx="${size}" ry="${size / 2}" ${fill}/>`);
    } else {
      const points = [0, 1, 2]
        .map(() => `${x + random.int(-size, size)},${y + random.int(-size, size)}`)
        .join(" ");

      figures.push(`<polygon points="${points}" ${fill}/>`);
    }
  }

  const fontSize = Math.round(Math.min(width, height) * 0.16);
  const caption = escapeXml(entry.relPath);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<defs>
<linearGradient id="sky" x1="${corners[0]}" y1="0" x2="${1 - (corners[0] ?? 0)}" y2="${corners[1]}">
<stop offset="0" stop-color="${hsl(random, 55, 35)}"/><stop offset="1" stop-color="${hsl(random, 65, 65)}"/>
</linearGradient>
<radialGradient id="glow"><stop offset="0" stop-color="${hsl(random, 90, 80)}" stop-opacity="0.9"/>
<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
</defs>
<rect width="100%" height="100%" fill="url(#sky)"/>
<circle cx="${random.int(0, width)}" cy="${random.int(0, height)}" r="${Math.round(height * 0.4)}" fill="url(#glow)"/>
${figures.join("\n")}
<text x="${Math.round(width * 0.05)}" y="${Math.round(height * 0.92)}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff" stroke="#000000" stroke-width="${Math.max(2, Math.round(fontSize / 40))}">#${entry.label}</text>
<text x="${Math.round(width * 0.05)}" y="${Math.round(height * 0.06)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(fontSize / 5)}" fill="#ffffff">${caption}</text>
</svg>`;
}

function encodeStill(image: sharp.Sharp, format: StillFormat, quality?: number): sharp.Sharp {
  return format === "avif"
    ? image.avif({ ...AVIF_OPTIONS, quality: quality ?? AVIF_OPTIONS.quality })
    : image.jpeg({ quality: quality ?? JPEG_QUALITY });
}

/** Draws an original still and writes it to `target`. */
export async function writeOriginalStill(
  seed: string,
  entry: StillEntry,
  target: string,
): Promise<void> {
  const drawn = await sharp(Buffer.from(stillSvg(seed, entry)))
    .composite([
      {
        input: await noiseTile(seed, entry.label % 8),
        raw: { width: NOISE_TILE, height: NOISE_TILE, channels: 3 },
        tile: true,
        blend: "soft-light",
      },
    ])
    .raw()
    .toBuffer({ resolveWithObject: true });

  let image = sharp(drawn.data, { raw: drawn.info }).removeAlpha();

  if (entry.rotated) {
    // Stored a quarter turn anticlockwise; orientation 6 tells a viewer to turn it clockwise.
    image = image.rotate(270).withMetadata({ orientation: 6 });
  }

  await encodeStill(image, entry.format).toFile(target);
}

/** Makes a duplicate or near-duplicate of `source` (already on disk) at `target`. */
export async function writeDerivedStill(
  entry: StillEntry,
  source: string,
  target: string,
): Promise<void> {
  const derivation = entry.derived;

  if (!derivation) {
    throw new Error(`${entry.relPath} is not derived`);
  }

  if (derivation.kind === "exact") {
    await copyFile(source, target);

    return;
  }

  // Upright pixels: autoOrient applies the source's EXIF orientation.
  let image = sharp(source).autoOrient();

  if (derivation.kind === "resize") {
    image = image.resize(entry.width, entry.height);
  }

  const quality =
    derivation.kind === "reencode"
      ? entry.format === "avif"
        ? REENCODE_AVIF_QUALITY
        : REENCODE_JPEG_QUALITY
      : undefined;

  await encodeStill(image, entry.format, quality).toFile(target);
}

/** A page of flat panels, as a scan of drawn art is: little grain, hard edges, a page number. */
function comicSvg(seed: string, entry: ComicPageEntry): string {
  const random = seededRandom(seed, `comic-art:${entry.comicIndex}:${entry.page}`);
  const { width, height } = entry;
  const margin = Math.round(width * 0.05);
  const gutter = Math.round(width * 0.02);
  const rows = random.int(2, 4);
  const panels: string[] = [];
  const rowHeight = (height - margin * 2 - gutter * (rows - 1)) / rows;

  for (let row = 0; row < rows; row += 1) {
    const columns = random.int(1, 3);
    const columnWidth = (width - margin * 2 - gutter * (columns - 1)) / columns;

    for (let column = 0; column < columns; column += 1) {
      const x = Math.round(margin + column * (columnWidth + gutter));
      const y = Math.round(margin + row * (rowHeight + gutter));
      panels.push(
        `<rect x="${x}" y="${y}" width="${Math.round(columnWidth)}" height="${Math.round(rowHeight)}" fill="${hsl(random, 45, random.int(40, 85))}" stroke="#111111" stroke-width="${Math.max(3, Math.round(width / 300))}"/>`,
        `<circle cx="${x + random.int(0, Math.round(columnWidth))}" cy="${y + random.int(0, Math.round(rowHeight))}" r="${random.int(20, Math.round(rowHeight / 3))}" fill="${hsl(random, 70, 50)}"/>`,
      );
    }
  }

  const fontSize = Math.round(Math.min(width, height) * 0.12);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="#f4f1e8"/>
${panels.join("\n")}
<text x="${margin * 2}" y="${margin * 2 + fontSize}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff" stroke="#000000" stroke-width="4">${entry.page}</text>
<text x="${margin}" y="${height - Math.round(margin / 3)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(margin / 2)}" fill="#333333">${escapeXml(entry.comic)} · ${entry.page}</text>
</svg>`;
}

export async function writeComicPage(
  seed: string,
  entry: ComicPageEntry,
  target: string,
): Promise<void> {
  const image = sharp(Buffer.from(comicSvg(seed, entry))).removeAlpha();

  if (entry.format === "png") {
    await image.png({ compressionLevel: 6 }).toFile(target);
  } else if (entry.format === "avif") {
    await image.avif(AVIF_OPTIONS).toFile(target);
  } else {
    await image.jpeg({ quality: 85 }).toFile(target);
  }
}

/** The number, codec and size, drawn into a corner of the video so each clip is told apart. */
async function writeVideoLabel(entry: VideoEntry, target: string): Promise<void> {
  const text = `${entry.codec} #${entry.label} ${entry.width}×${entry.height} ${entry.fps} fps`;
  const height = Math.round(Math.min(entry.width, entry.height) * 0.08);
  const fontSize = Math.round(height * 0.55);
  // Helvetica Bold averages about 0.6 em a character.
  const width = Math.round(fontSize * 0.62 * text.length + height * 0.6);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" rx="${Math.round(height / 4)}" fill="#000000" fill-opacity="0.6"/>
<text x="${Math.round(height * 0.3)}" y="${Math.round(height * 0.7)}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff">${text}</text>
</svg>`;

  await sharp(Buffer.from(svg)).png().toFile(target);
}

/**
 * Bit rate ceilings by the short edge, about a phone's. Grain in every frame would otherwise make
 * a CRF encode tens of megabits a second, and 300 of those would not fit the budget.
 */
function maxKbps(entry: VideoEntry): number {
  const short = Math.min(entry.width, entry.height);
  const h264 = short <= 720 ? 5000 : short <= 1080 ? 9000 : 14000;
  const scale = entry.codec === "h264" ? 1 : entry.codec === "hevc" ? 0.65 : 0.5;

  return Math.round(h264 * scale * Math.max(1, entry.fps / 30));
}

function videoCodecArguments(entry: VideoEntry, threads: number): string[] {
  const max = maxKbps(entry);
  const rate = ["-maxrate", `${max}k`, "-bufsize", `${max * 2}k`];

  if (entry.codec === "h264") {
    return [
      "-c:v",
      "libx264",
      "-preset",
      "faster",
      "-crf",
      "21",
      ...rate,
      "-threads",
      `${threads}`,
    ];
  }

  if (entry.codec === "hevc") {
    // `hvc1`, not ffmpeg's default `hev1`: AVPlayer and QuickTime refuse HEVC tagged `hev1`.
    return [
      "-c:v",
      "libx265",
      "-preset",
      "faster",
      "-crf",
      "24",
      ...rate,
      "-tag:v",
      "hvc1",
      "-x265-params",
      `log-level=error:pools=${threads}`,
    ];
  }

  return [
    "-c:v",
    "libsvtav1",
    "-preset",
    "10",
    "-crf",
    "36",
    ...rate,
    "-svtav1-params",
    `lp=${threads}`,
  ];
}

/**
 * A clip as Electron Oriel's e2e Shrink spec made one, `testsrc2` with temporal noise and a
 * sine tone, at the entry's size, rate and length, with its label drawn in.
 */
export async function writeVideo(
  entry: VideoEntry,
  target: string,
  labelPath: string,
  threads: number,
): Promise<void> {
  await writeVideoLabel(entry, labelPath);

  const picture = `testsrc2=s=${entry.width}x${entry.height}:r=${entry.fps}:d=${entry.seconds},noise=alls=14:allf=t+u:all_seed=${entry.noiseSeed}`;
  const margin = Math.round(Math.min(entry.width, entry.height) * 0.05);

  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    picture,
    "-loop",
    "1",
    "-i",
    labelPath,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${entry.toneHz}:duration=${entry.seconds}`,
    "-filter_complex",
    `[0:v][1:v]overlay=${margin}:${margin}:shortest=1,format=yuv420p[v]`,
    "-map",
    "[v]",
    "-map",
    "2:a",
    "-t",
    `${entry.seconds}`,
    ...videoCodecArguments(entry, threads),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    target,
  ]);
}
