import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import sharp from "sharp";
import { electronChildEnv, REPO_ROOT } from "../src/env.ts";

const appDir = path.join(REPO_ROOT, "apps/frame-view");

const label = process.argv[2] ?? "current";

const root = await mkdtemp(path.join(os.tmpdir(), "frame-perf-"));

const archive = path.join(root, "archive");

try {
  await mkdir(archive);

  const fixtureDir = process.env.FRAME_PERF_FIXTURE_DIR;

  const rapidScroll = process.env.FRAME_PERF_RAPID_SCROLL === "1";

  const extension = fixtureDir ? "avif" : "png";

  if (fixtureDir) {
    const files = (await readdir(fixtureDir))
      .filter((name) => name.endsWith(".avif"))
      .sort()
      .slice(0, 80);

    assert.equal(files.length, 80);

    for (const [index, file] of files.entries()) {
      await copyFile(
        path.join(fixtureDir, file),
        path.join(archive, `image-${String(index).padStart(2, "0")}.avif`),
      );
    }
  } else {
    const width = 2048;
    const height = 1536;
    const pixels = Buffer.alloc(width * height * 3);
    let seed = 42;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const noise = (seed >>> 24) / 8;
        const index = (y * width + x) * 3;
        pixels[index] = (x / 8 + Math.sin(y / 23) * 50 + noise) & 255;
        pixels[index + 1] = (y / 6 + Math.sin(x / 31) * 60 + noise) & 255;
        pixels[index + 2] = ((x + y) / 14 + noise) & 255;
      }
    }

    const first = path.join(archive, "image-00.png");
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(first);

    for (let i = 1; i < 80; i++) {
      await copyFile(first, path.join(archive, `image-${String(i).padStart(2, "0")}.png`));
    }
  }

  const env = electronChildEnv();

  delete env.FRAME_VIEW_DISABLE_GPU;

  const binary =
    process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : process.platform === "win32"
        ? "electron.exe"
        : "electron";

  for (let round = 0; round < 3; round++) {
    const app = await electron.launch({
      args: [
        path.join(appDir, ".vite/build/main.js"),
        `--user-data-dir=${path.join(root, `user-${round}`)}`,
      ],
      cwd: appDir,
      env,
      executablePath: path.join(appDir, "node_modules/electron/dist", binary),
    });

    try {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Open", exact: true }).waitFor();
      await app.evaluate(({ dialog, BrowserWindow }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
        BrowserWindow.getAllWindows()[0]?.setSize(1280, 900);
      }, archive);
      const start = performance.now();
      await page.getByRole("button", { name: "Open", exact: true }).click();
      await page.waitForFunction(
        () => {
          const images = [
            ...document.querySelectorAll<HTMLImageElement>("[data-gallery-item] img"),
          ];

          const visible = images.filter((image) => {
            const rect = image.getBoundingClientRect();

            return rect.top < innerHeight && rect.bottom > 0;
          });

          return (
            visible.length >= 8 &&
            visible.every((image) => image.complete && image.naturalWidth > 0)
          );
        },
        undefined,
        { timeout: 60000 },
      );
      const coldMs = performance.now() - start;

      const dimensions = await page
        .locator("[data-gallery-item] img")
        .first()
        .evaluate((img: HTMLImageElement) => ({
          width: img.naturalWidth,
          height: img.naturalHeight,
        }));

      assert.equal(Math.max(dimensions.width, dimensions.height), 440);
      const scrolledAt = performance.now();

      if (rapidScroll) {
        for (const fraction of [0.25, 0.5, 0.75, 0.35]) {
          await page.locator("[data-gallery-scroll-container]").evaluate((element, position) => {
            element.scrollTop = element.scrollHeight * position;
          }, fraction);
          await page.waitForTimeout(40);
        }
      }

      await page.locator("[data-gallery-scroll-container]").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForFunction(
        (lastName) => {
          const images = [
            ...document.querySelectorAll<HTMLImageElement>("[data-gallery-item] img"),
          ];

          const last = images.find((image) => image.alt === lastName);

          const visible = images.filter((image) => {
            const rect = image.getBoundingClientRect();

            return rect.top < innerHeight && rect.bottom > 0;
          });

          return (
            last?.complete &&
            last.naturalWidth > 0 &&
            visible.length >= 8 &&
            visible.every((image) => image.complete && image.naturalWidth > 0)
          );
        },
        `image-79.${extension}`,
        { timeout: 60000 },
      );
      const scrollMs = performance.now() - scrolledAt;

      const memoryKiB = await app.evaluate(({ app }) =>
        app.getAppMetrics().reduce((total, metric) => total + metric.memory.workingSetSize, 0),
      );

      const diagnostics = await page.evaluate(`(async () => {
      const result = await window.frameView.debug.getDiagnosticsSnapshot();
      if (!('value' in result)) throw new Error('Diagnostics unavailable');
      const { abortedCount, generatedCount, imageWorkerCount } = result.value.thumbnails;
      return { abortedCount, generatedCount, imageWorkerCount };
    })()`);

      console.log(
        JSON.stringify({ label, round, coldMs, scrollMs, dimensions, memoryKiB, diagnostics }),
      );

      if (fixtureDir) {
        const thumbnails = await page.locator("[data-gallery-item] img").evaluateAll((elements) => {
          const images = elements.filter(
            (element): element is HTMLImageElement =>
              element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
          );

          return images.map((image) => ({ name: image.alt, url: image.src }));
        });

        for (const thumbnail of thumbnails) {
          const bytes = await app.evaluate(
            async ({ net }, url) =>
              Array.from(new Uint8Array(await (await net.fetch(url)).arrayBuffer())),
            thumbnail.url,
          );

          const expected = await sharp(path.join(archive, thumbnail.name), {
            animated: false,
            sequentialRead: true,
          })
            .rotate()
            .resize({ width: 440, height: 440, fit: "inside", withoutEnlargement: false })
            .webp({ quality: 92, effort: 5 })
            .toBuffer();

          assert.ok(Buffer.from(bytes).equals(expected), "AVIF thumbnail bytes changed");
        }

        console.log(JSON.stringify({ label, round, identicalAvifThumbnails: thumbnails.length }));
      }

      const maxScrollMs = Number(process.env.FRAME_PERF_MAX_SCROLL_MS ?? Infinity);
      assert.ok(
        scrollMs < maxScrollMs,
        `Scroll took ${scrollMs.toFixed(0)} ms; target ${maxScrollMs} ms`,
      );
    } finally {
      await app.close();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
