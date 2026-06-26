import { THUMBNAIL_SIZE_LADDER } from "@latch-works/media-delivery";
import sharp from "sharp";
import { resizeImageToWebp } from "../src/image.js";

const SOURCE_WIDTH = 3840;
const SOURCE_HEIGHT = 2160;

function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

async function createSynthetic4kPhoto(): Promise<Buffer> {
  const pixels = Buffer.alloc(SOURCE_WIDTH * SOURCE_HEIGHT * 3);
  for (let y = 0; y < SOURCE_HEIGHT; y += 1) {
    for (let x = 0; x < SOURCE_WIDTH; x += 1) {
      const index = (y * SOURCE_WIDTH + x) * 3;
      pixels[index] = (x * 17 + y * 31) % 256;
      pixels[index + 1] = (x * 29 + y * 13) % 256;
      pixels[index + 2] = (x * 7 + y * 43) % 256;
    }
  }

  return sharp(pixels, {
    raw: { channels: 3, height: SOURCE_HEIGHT, width: SOURCE_WIDTH },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function main(): Promise<void> {
  const source = await createSynthetic4kPhoto();
  const sourceKb = formatKb(source.byteLength);

  console.log("# Thumbnail size storage analysis");
  console.log();
  console.log(`Synthetic source: ${SOURCE_WIDTH}×${SOURCE_HEIGHT} JPEG (~${sourceKb} KB)`);
  console.log(`Encoder: sharp WebP quality 90, fit inside max edge`);
  console.log();
  console.log("| Step | Output dims | Bytes | KB |");
  console.log("| --- | --- | ---: | ---: |");

  const rows: Array<{ bytes: number; height: number; size: number; width: number }> = [];

  for (const size of THUMBNAIL_SIZE_LADDER) {
    const derivative = await resizeImageToWebp(source, size);
    rows.push({
      bytes: derivative.bytes.byteLength,
      height: derivative.height,
      size,
      width: derivative.width,
    });
    console.log(
      `| ${size} | ${derivative.width}×${derivative.height} | ${derivative.bytes.byteLength} | ${formatKb(derivative.bytes.byteLength)} |`,
    );
  }

  const gallery = rows.find((row) => row.size === 720);
  const preview = rows.find((row) => row.size === 1080);
  const legacyGallery = rows.find((row) => row.size === 320);
  const legacyPreview = rows.find((row) => row.size === 960);

  console.log();
  if (gallery && preview) {
    console.log(
      `New gallery + preview pair (720 + 1080): ${formatKb(gallery.bytes + preview.bytes)} KB`,
    );
  }
  if (legacyGallery && legacyPreview) {
    console.log(
      `Previous gallery + preview pair (320 + 960): ${formatKb(legacyGallery.bytes + legacyPreview.bytes)} KB`,
    );
  }
}

await main();
