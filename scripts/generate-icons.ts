/**
 * Renders the platform icon formats from the SVG masters listed in docs/design/icons.md.
 *
 * Each master is rasterised once at 2048 px and downsampled with Lanczos for every output size,
 * so the small favicons stay crisp. ICO and ICNS containers are written directly: both are a
 * short header followed by PNG-encoded entries.
 *
 * Usage, from the repository root: pnpm icons
 */
import { copyFile, writeFile } from "node:fs/promises";
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
for (const app of ["frame-view", "lockstep"]) {
  await generateDesktopIcons(app);
}
await generateExtensionIcons();

// macOS 26 packaging also reads the Icon Composer bundle, which wants the same 1024 px PNG.
await copyFile(
  path.join(root, "apps/lockstep/media/lockstep-icon.png"),
  path.join(root, "apps/lockstep/media/lockstep-icon.icon/Assets/lockstep-icon.png"),
);
console.log("copied apps/lockstep/media/lockstep-icon.icon/Assets/lockstep-icon.png");
