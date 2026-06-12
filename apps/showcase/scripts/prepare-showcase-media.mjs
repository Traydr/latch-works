#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const showcaseRoot = join(scriptDir, "..");
const frameMediaDir = join(showcaseRoot, "../frame-view/showcase-media");
const archiveDir = process.env.LOCKSTEP_SOURCE ?? "/tmp/showcase-archive";
const photosDir = join(archiveDir, "sfw/photos");

const require = createRequire(join(showcaseRoot, "../frame-view/package.json"));
const sharp = require("sharp");

const palette = [
  "#18181b",
  "#27272a",
  "#3f3f46",
  "#52525b",
  "#8b5cf6",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#f43f5e",
];

async function main() {
  mkdirSync(photosDir, { recursive: true });
  mkdirSync(frameMediaDir, { recursive: true });

  for (let index = 0; index < 18; index += 1) {
    const fileName = `sample-${String(index + 1).padStart(2, "0")}.jpg`;
    const archivePath = join(photosDir, fileName);
    const framePath = join(frameMediaDir, fileName);
    const color = palette[index % palette.length];

    if (!existsSync(archivePath)) {
      const label = String(index + 1).padStart(2, "0");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">
      <rect width="1600" height="1200" fill="${color}"/>
      <rect x="80" y="80" width="1440" height="1040" rx="48" fill="#09090b" opacity="0.25"/>
      <text x="800" y="620" text-anchor="middle" fill="#f4f4f5" font-family="Segoe UI, system-ui, sans-serif" font-size="120" font-weight="600">${label}</text>
    </svg>`;

      const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
      writeFileSync(archivePath, jpeg);
    }

    copyFileSync(archivePath, framePath);
  }

  console.log(`Prepared showcase media in ${photosDir} and ${frameMediaDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
