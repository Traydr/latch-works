/**
 * Renders the platform icon formats from the SVG masters listed in docs/design/icons.md.
 *
 * Each master is rasterised once at 2048 px and downsampled with Lanczos for every output size,
 * so the small favicons stay crisp. ICO and ICNS containers are written directly: both are a
 * short header followed by PNG-encoded entries.
 *
 * Usage, from the repository root: pnpm icons
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The masters use a 1024-unit viewBox at 72 dpi, so doubling the density renders 2048 px. */
const MASTER_DENSITY = 144;

const MASTER_SIZE = 2048;

const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/** ICNS element types by pixel size. The `@2x` types share pixels with the next size up. */
const ICNS_TYPES: ReadonlyArray<readonly [type: string, size: number]> = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];

type RenderAt = (size: number) => Promise<Buffer>;

async function loadMaster(svgPath: string): Promise<RenderAt> {
  const master = await sharp(path.join(root, svgPath), { density: MASTER_DENSITY })
    .resize(MASTER_SIZE, MASTER_SIZE)
    .png()
    .toBuffer();

  const cache = new Map<number, Promise<Buffer>>();

  return (size) => {
    const cached = cache.get(size);

    if (cached) {
      return cached;
    }

    const rendered = sharp(master)
      .resize(size, size, { kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9 })
      .toBuffer();

    cache.set(size, rendered);

    return rendered;
  };
}

async function renderSizes(renderAt: RenderAt, sizes: readonly number[]): Promise<Buffer[]> {
  return Promise.all(sizes.map((size) => renderAt(size)));
}

/** ICO: 6-byte header, one 16-byte directory entry per image, then the PNG payloads. */
function encodeIco(sizes: readonly number[], images: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((png, index) => {
    const size = sizes[index] ?? 0;
    const entry = index * 16;
    // Width and height are one byte each; 256 is stored as 0.
    directory.writeUInt8(size % 256, entry);
    directory.writeUInt8(size % 256, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images]);
}

/** ICNS: an `icns` header, then `type + length + PNG` elements. Lengths include their header. */
function encodeIcns(types: readonly string[], images: readonly Buffer[]): Buffer {
  const elements = images.map((png, index) => {
    const header = Buffer.alloc(8);
    header.write(types[index] ?? "", 0, "ascii");
    header.writeUInt32BE(header.length + png.length, 4);

    return Buffer.concat([header, png]);
  });

  const body = Buffer.concat(elements);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(header.length + body.length, 4);

  return Buffer.concat([header, body]);
}

async function write(relativePath: string, data: Buffer): Promise<void> {
  await writeFile(path.join(root, relativePath), data);
  console.log(`wrote ${relativePath} (${data.length} bytes)`);
}

async function writeIco(relativePath: string, renderAt: RenderAt): Promise<void> {
  await write(relativePath, encodeIco(ICO_SIZES, await renderSizes(renderAt, ICO_SIZES)));
}

/** Web apps serve the SVG directly; these are the legacy-browser and iOS fallbacks. */
async function generateWebIcons(app: string): Promise<void> {
  const directory = path.join("apps", app, "public");
  const renderAt = await loadMaster(path.join(directory, "favicon.svg"));
  await write(path.join(directory, "apple-touch-icon.png"), await renderAt(180));
  await writeIco(path.join(directory, "favicon.ico"), renderAt);
}

/** Electron apps: the PNG is the window and Linux icon, ICO is Windows, ICNS is macOS. */
async function generateDesktopIcons(app: string): Promise<void> {
  const base = path.join("apps", app, "media", `${app}-icon`);
  const renderAt = await loadMaster(`${base}.svg`);
  await write(`${base}.png`, await renderAt(1024));
  await writeIco(`${base}.ico`, renderAt);
  const types = ICNS_TYPES.map(([type]) => type);
  const sizes = ICNS_TYPES.map(([, size]) => size);
  await write(`${base}.icns`, encodeIcns(types, await renderSizes(renderAt, sizes)));
}

/**
 * BMP, which Windows Installer reads and sharp cannot write: a 54-byte header, then 24-bit BGR
 * rows bottom-up, each padded to a multiple of four bytes.
 */
function encodeBmp(width: number, height: number, rgb: Buffer): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y += 1) {
    const target = (height - 1 - y) * rowSize;

    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 3;
      pixels[target + x * 3] = rgb[source + 2] ?? 0;
      pixels[target + x * 3 + 1] = rgb[source + 1] ?? 0;
      pixels[target + x * 3 + 2] = rgb[source] ?? 0;
    }
  }

  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(header.length + pixels.length, 2);
  header.writeUInt32LE(header.length, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);

  return Buffer.concat([header, pixels]);
}

const SPLASH_WIDTH = 480;

const SPLASH_HEIGHT = 300;

const SPLASH_FRAMES = 36;

/** How far along `t` is between `from` and `to`, eased, from 0 to 1. */
function phase(t: number, from: number, to: number): number {
  const linear = Math.min(1, Math.max(0, (t - from) / (to - from)));

  return 1 - (1 - linear) ** 3;
}

/**
 * One frame of Setup.exe's splash at `t` (0 to 1): the bay window's cap and sill draw in, its
 * panes light up left, centre, right, the sun rises, and the name follows.
 */
function splashFrame(t: number): string {
  const frame = phase(t, 0, 0.35);
  const pane = (index: number) => phase(t, 0.2 + index * 0.12, 0.45 + index * 0.12).toFixed(3);
  const sun = phase(t, 0.55, 0.85);
  const name = phase(t, 0.7, 1);
  const capLength = 760;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SPLASH_WIDTH}" height="${SPLASH_HEIGHT}" viewBox="0 0 ${SPLASH_WIDTH} ${SPLASH_HEIGHT}">
<rect width="${SPLASH_WIDTH}" height="${SPLASH_HEIGHT}" fill="#2d323a"/>
<defs><clipPath id="panes">
<path d="M362 304H662V748H362Z"/><path d="M170 346L338 304V748L170 706Z"/><path d="M854 346L686 304V748L854 706Z"/>
</clipPath></defs>
<g transform="translate(148 28) scale(0.18)">
<g clip-path="url(#panes)">
<g opacity="${pane(0)}"><path fill="#cfc9bb" d="M150 280H338V780H150Z"/><path fill="#6f9c9d" d="M150 616C230 568 290 540 338 532V780H150Z"/></g>
<g opacity="${pane(1)}"><path fill="#fbf3df" d="M362 280H662V780H362Z"/>
<circle fill="#f4cb70" cx="590" cy="${(560 - 114 * sun).toFixed(1)}" r="64"/>
<path fill="#80b4b5" d="M362 535C420 512 480 506 540 526C590 546 630 548 662 541V780H362Z"/>
<path fill="#aac69d" d="M362 663C420 666 480 676 540 696S630 722 662 720V780H362Z"/></g>
<g opacity="${pane(2)}"><path fill="#cfc9bb" d="M686 280H880V780H686Z"/><path fill="#6f9c9d" d="M686 528C760 518 820 496 880 476V780H686Z"/></g>
</g>
<path fill="none" stroke="#e99b89" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${capLength}" stroke-dashoffset="${(capLength * (1 - frame)).toFixed(1)}" d="M164 318L338 274H686L860 318"/>
<path fill="none" stroke="#e99b89" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${capLength}" stroke-dashoffset="${(capLength * (1 - frame)).toFixed(1)}" d="M164 734L338 778H686L860 734"/>
</g>
<text x="240" y="220" text-anchor="middle" fill="#fbf3df" opacity="${name.toFixed(3)}" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="26" font-weight="600">Oriel</text>
</svg>`;
}

/** Setup.exe's splash: the assembly once, then the finished mark held while it installs. */
async function renderSplash(): Promise<Buffer> {
  const frames = await Promise.all(
    Array.from({ length: SPLASH_FRAMES }, (_, index) =>
      sharp(Buffer.from(splashFrame(index / (SPLASH_FRAMES - 1))))
        .png()
        .toBuffer(),
    ),
  );

  const delay = frames.map((_, index) => (index === frames.length - 1 ? 6000 : 45));

  return sharp(frames, { join: { animated: true } })
    .gif({ delay, loop: 0, effort: 10 })
    .toBuffer();
}

/** Oriel's installer art: the DMG's background at 1x and 2x, and Windows' MSI bitmaps and splash. */
async function generateInstallerArt(): Promise<void> {
  const directory = path.join("apps", "oriel", "installer");
  const dmg = path.join(root, directory, "dmg-background.svg");
  await write(path.join(directory, "dmg-background.png"), await sharp(dmg).png().toBuffer());
  await write(
    path.join(directory, "dmg-background@2x.png"),
    await sharp(dmg, { density: 144 }).png().toBuffer(),
  );

  for (const [name, width, height] of [
    ["msi-banner", 493, 58],
    ["msi-dialog", 493, 312],
  ] as const) {
    const { data } = await sharp(path.join(root, directory, `${name}.svg`))
      .resize(width, height)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    await write(path.join(directory, `${name}.bmp`), encodeBmp(width, height, data));
  }

  await write(path.join(directory, "splash.gif"), await renderSplash());
}

async function generateExtensionIcons(): Promise<void> {
  const directory = path.join("apps", "gather-box", "assets", "icons");
  const renderAt = await loadMaster(path.join(directory, "gather-box-icon.svg"));
  await write(path.join(directory, "gather-box-icon.png"), await renderAt(1024));

  for (const size of [16, 32, 48, 128]) {
    await write(path.join(directory, `icon${size}.png`), await renderAt(size));
  }
}

for (const app of ["pane-view", "showcase"]) {
  await generateWebIcons(app);
}

for (const app of ["oriel"]) {
  await generateDesktopIcons(app);
}

await generateExtensionIcons();

await generateInstallerArt();
