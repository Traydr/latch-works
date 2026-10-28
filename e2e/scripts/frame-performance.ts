import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test";
import sharp from "sharp";
import { z } from "zod";
import { electronChildEnv, REPO_ROOT } from "../src/env.ts";

const appDir = path.join(REPO_ROOT, "apps/oriel");

const label = process.argv[2] ?? "current";

const binary =
  process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";

/**
 * The default run: 80 copies of one synthetic PNG (or 80 AVIFs from `FRAME_PERF_FIXTURE_DIR`),
 * three fresh launches, each timing the first thumbnails and a jump to the bottom.
 */
async function runSynthetic(): Promise<void> {
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

    delete env.ORIEL_DISABLE_GPU;

    for (let round = 0; round < 3; round++) {
      const app = await electron.launch({
        args: [
          path.join(appDir, ".vite/build/main.cjs"),
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
          const thumbnails = await page
            .locator("[data-gallery-item] img")
            .evaluateAll((elements) => {
              const images = elements.filter(
                (element): element is HTMLImageElement =>
                  element instanceof HTMLImageElement &&
                  element.complete &&
                  element.naturalWidth > 0,
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
}

/*
 * Fixture mode (plan 063, Phase 0's baseline): View on the spike fixture, measured as Oriel
 * GPUI's spike measures its own View (`apps/oriel-gpui/crates/mode-view/src/spike.rs`).
 *
 *   FRAME_PERF_FIXTURE_ROOT  the fixture: `stills/` (opened recursively) and `videos/<codec>/`
 *   FRAME_PERF_PHASES        any of `open,coldstart,warmstart,warm` (default all, in that order)
 *   FRAME_PERF_STILLS        the stills the recursive scan must list (default 20000)
 *   FRAME_PERF_WORK_DIR      where the userData folders go (default a fresh temp folder; kept)
 *   FRAME_PERF_REST_MS       the rests (default 60000, as the scorecard asks; shorter for a smoke)
 *
 * `open`: a fresh userData; turns on "Enable recursive mode by default" (for the later launches),
 * sizes the window, presses Open (the dialog stubbed) and Recursive, and times Recursive to the
 * first frame drawing every visible tile's thumbnail, then the scan to every still listed, then
 * scrolls once top to bottom (the thumbnails made on the way).
 * `coldstart`: a fresh userData holding only the settings and window state `open` saved, so the
 * folder opens at launch with no index and no thumbnails; times launch to the first thumbnails.
 * `warmstart`: relaunches `coldstart`'s userData, whose first screen of thumbnails is on disk
 * (View keeps 5,000 thumbnails, so after `open`'s scroll the top of the gallery is no longer
 * cached); times launch to the first thumbnails, then CPU from 30 s to 90 s after them, settled,
 * and memory at 60 s and 90 s.
 * `warm`: relaunches `open`'s userData; times launch to the first thumbnails, then memory and CPU
 * 60 s at rest, the scroll at 5,000 px/s, memory and CPU 60 s after it, viewer steps, and video.
 *
 * Every number is a JSON line on stdout. Memory and CPU are summed over Oriel's whole process
 * tree (main, renderers, GPU, utilities) from `ps` and `footprint`, not only `getAppMetrics`.
 */

const SCROLL_PX_PER_S = 5000;

const REST_MS = Number(process.env.FRAME_PERF_REST_MS ?? 60_000);

/** How long after the first thumbnails a settled idle window starts. */
const SETTLE_MS = REST_MS / 2;

const VIEWPORT = { width: 1280, height: 900 };

const VIDEO_CODECS = ["h264", "hevc", "av1"] as const;

const VIDEOS_PER_CODEC = 10;

const STEPS_PER_FORMAT = 20;

const execFileAsync = promisify(execFile);

interface FixtureContext {
  env: Record<string, string>;
  root: string;
  round: string;
  stills: number;
  work: string;
}

interface Launched {
  app: ElectronApplication;
  page: Page;
  /** `Date.now()` just before Playwright spawned Electron. */
  spawnedAt: number;
  /** How many windows existed when the first-thumbnails probe went in as an init script. */
  windowsBeforeProbe: number;
}

/** What the page probe reports for the first frame with every visible thumbnail drawn. */
const FirstThumbnailsSchema = z.object({
  epochMs: z.number(),
  lastThumbnailArrivedMs: z.number().nullable(),
  pageMs: z.number(),
  probeInstalledMs: z.number(),
  tiles: z.number(),
  viewport: z.array(z.number()),
});

type FirstThumbnails = z.infer<typeof FirstThumbnailsSchema>;

/** View's thumbnail counters, from its own diagnostics snapshot. */
const ThumbnailStateSchema = z.object({
  abortedCount: z.number(),
  diskCacheHits: z.number(),
  generatedCount: z.number(),
  imageQueueDepth: z.number(),
  imageWorkerCount: z.number(),
  inflightRequests: z.number(),
  memoryCacheHits: z.number(),
  videoQueueDepth: z.number(),
});

const ScrollResultSchema = z.object({
  columns: z.number(),
  distance: z.number(),
  now: z.array(z.number()),
  rowStride: z.number(),
  stamps: z.array(z.number()),
  viewport: z.array(z.number()),
});

const StepAttemptSchema = z.object({
  ms: z.number().nullable(),
  name: z.string(),
  width: z.number().optional(),
});

const VideoFirstFrameSchema = z
  .object({ mediaTime: z.number(), ms: z.number(), presentedMs: z.number() })
  .nullable();

const SeekSchema = z.object({
  before: z.number(),
  landed: z.number().optional(),
  ms: z.number().nullable(),
  target: z.number(),
});

interface ProcessSample {
  command: string;
  cpuSeconds: number;
  pid: number;
  rssKiB: number;
}

interface CpuSnapshot {
  at: number;
  cpu: Map<number, number>;
}

function emit<Fields extends object>(event: string, fields: Fields): void {
  console.log(JSON.stringify({ label, event, at: Date.now(), ...fields }));
}

async function runFixture(root: string): Promise<void> {
  const phases = new Set(
    (process.env.FRAME_PERF_PHASES ?? "open,coldstart,warmstart,warm").split(","),
  );

  const work =
    process.env.FRAME_PERF_WORK_DIR ?? (await mkdtemp(path.join(os.tmpdir(), "frame-perf-")));

  const env = electronChildEnv();

  delete env.ORIEL_DISABLE_GPU;
  await mkdir(work, { recursive: true });

  const context: FixtureContext = {
    env,
    root,
    round: label,
    stills: Number(process.env.FRAME_PERF_STILLS ?? 20000),
    work,
  };

  emit("fixture-start", { root, work, phases: [...phases] });

  if (phases.has("open")) await openPhase(context);

  if (phases.has("coldstart")) await coldStartPhase(context);

  if (phases.has("warmstart")) await warmStartPhase(context);

  if (phases.has("warm")) await warmPhase(context);
}

/**
 * The page side, as source text: tsx wraps named functions in a `__name` helper the page does not
 * have, so nothing passed to the page is a compiled function with names inside.
 *
 * It records the last click and double click, and watches each frame until the first one that
 * draws every visible tile's thumbnail: all loaded, decoded, and a frame begun after that.
 */
const PAGE_PROBE = `(() => {
  if (window.__framePerf) return;
  const state = {
    installedAt: performance.now(),
    lastClickAt: null,
    lastDoubleClickAt: null,
    firstThumbnails: null,
    steps: { running: false, pending: null, attempts: [] },
    video: null,
  };
  window.__framePerf = state;
  document.addEventListener("click", () => { state.lastClickAt = performance.now(); }, true);
  document.addEventListener("dblclick", () => { state.lastDoubleClickAt = performance.now(); }, true);
  state.visibleTiles = () => {
    const container = document.querySelector("[data-gallery-scroll-container]");
    if (!container) return [];
    const box = container.getBoundingClientRect();
    return [...container.querySelectorAll("[data-gallery-item]")].filter((tile) => {
      const rect = tile.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < box.bottom;
    });
  };
  const watchFirst = () => {
    const tiles = state.visibleTiles();
    const images = tiles.map((tile) => tile.querySelector("img"));
    const ready = tiles.length > 0 &&
      images.every((image) => image && image.complete && image.naturalWidth > 0);
    if (!ready) {
      requestAnimationFrame(watchFirst);
      return;
    }
    Promise.all(images.map((image) => image.decode().catch(() => undefined))).then(() => {
      requestAnimationFrame(() => {
        const now = performance.now();
        // When the last visible thumbnail's bytes arrived, from resource timing: a check that
        // the probe (installed after the page started when the window already existed) was
        // watching before the thumbnails came, not after.
        const arrived = images.map((image) => {
          const entries = performance.getEntriesByName(image.currentSrc);
          return entries.length > 0 ? entries[entries.length - 1].responseEnd : null;
        });
        state.firstThumbnails = {
          epochMs: performance.timeOrigin + now,
          pageMs: now,
          probeInstalledMs: state.installedAt,
          lastThumbnailArrivedMs: arrived.every((at) => at !== null) ? Math.max(...arrived) : null,
          tiles: tiles.length,
          viewport: [innerWidth, innerHeight, devicePixelRatio],
        };
      });
    });
  };
  requestAnimationFrame(watchFirst);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" || !state.steps.running) return;
    const dialog = document.querySelector("dialog[open]");
    state.steps.pending = {
      start: performance.now(),
      from: dialog ? dialog.getAttribute("aria-label") : null,
      attempt: null,
      decoding: false,
    };
  }, true);
  const watchSteps = () => {
    if (!state.steps.running) return;
    const pending = state.steps.pending;
    const dialog = document.querySelector("dialog[open]");
    if (pending && dialog) {
      const name = (dialog.getAttribute("aria-label") || "").replace(/^Viewer for /, "");
      if (!pending.attempt && dialog.getAttribute("aria-label") !== pending.from) {
        pending.attempt = { name, ms: null };
        state.steps.attempts.push(pending.attempt);
      }
      const image = dialog.querySelector("img");
      if (pending.attempt && !pending.decoding && image && image.alt === pending.attempt.name &&
          image.complete && image.naturalWidth > 0) {
        pending.decoding = true;
        image.decode().catch(() => undefined).then(() => requestAnimationFrame(() => {
          if (state.steps.pending === pending) {
            pending.attempt.ms = performance.now() - pending.start;
            pending.attempt.width = image.naturalWidth;
            state.steps.pending = null;
          }
        }));
      }
    }
    requestAnimationFrame(watchSteps);
  };
  state.startSteps = () => {
    state.steps = { running: true, pending: null, attempts: [] };
    requestAnimationFrame(watchSteps);
  };
  state.stopSteps = () => {
    state.steps.running = false;
    return state.steps.attempts;
  };
})()`;

/**
 * Scrolls the gallery from the top to its end at `speed` px/s of wall time, setting `scrollTop`
 * from the elapsed time in each animation frame, as Oriel GPUI's autoscroll does; returns every
 * frame's `performance.now()` and the frame timestamps Chromium hands `requestAnimationFrame`.
 */
const PAGE_SCROLL = `(async (speed) => {
  const container = document.querySelector("[data-gallery-scroll-container]");
  container.scrollTop = 0;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const end = container.scrollHeight - container.clientHeight;
  const now = [];
  const stamps = [];
  let start = null;
  await new Promise((resolve) => {
    const frame = (stamp) => {
      const at = performance.now();
      if (start === null) start = at;
      now.push(at);
      stamps.push(stamp);
      const top = Math.min(end, ((at - start) / 1000) * speed);
      container.scrollTop = top;
      if (top >= end) {
        resolve();
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const grid = document.querySelector("[data-gallery-grid]");
  return {
    now,
    stamps,
    distance: end,
    columns: Number(grid?.getAttribute("data-gallery-columns")),
    rowStride: Number(grid?.getAttribute("data-gallery-row-height")),
    viewport: [innerWidth, innerHeight, devicePixelRatio],
  };
})`;

/** The display's frame interval as Chromium paces `requestAnimationFrame`, over 240 frames. */
const PAGE_REFRESH = `(async () => {
  const stamps = [];
  await new Promise((resolve) => {
    const frame = (stamp) => {
      stamps.push(stamp);
      if (stamps.length > 240) resolve();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const intervals = stamps.slice(1).map((stamp, index) => stamp - stamps[index]).sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)];
})()`;

/**
 * Before a video tile is double-clicked: catches the viewer's `<video>` as it is created and
 * times the double click to its first frame (`requestVideoFrameCallback`).
 */
const PAGE_VIDEO_PROBE = `(() => {
  const state = window.__framePerf;
  state.video = { first: null, element: null };
  const observer = new MutationObserver(() => {
    const video = document.querySelector("dialog[open] video");
    if (!video || state.video.element) return;
    state.video.element = video;
    observer.disconnect();
    video.requestVideoFrameCallback((now, metadata) => {
      state.video.first = {
        ms: now - state.lastDoubleClickAt,
        presentedMs: metadata.presentationTime - state.lastDoubleClickAt,
        mediaTime: metadata.mediaTime,
      };
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
})()`;

/**
 * Seeks the viewer's video to `share` of its length and times the call to the first frame shown
 * from there: `exact` sets `currentTime`; `fast` calls `fastSeek`, as View's own seek bar does.
 */
const PAGE_SEEK = `(async ({ share, mode }) => {
  const video = document.querySelector("dialog[open] video");
  const target = video.duration * share;
  const before = video.currentTime;
  return await new Promise((resolve) => {
    const start = performance.now();
    const timer = setTimeout(() => resolve({ ms: null, target, before }), 10000);
    const frame = (now, metadata) => {
      const arrived = target >= before
        ? metadata.mediaTime >= target - 0.05
        : metadata.mediaTime <= target + 0.05;
      if (arrived) {
        clearTimeout(timer);
        resolve({ ms: now - start, target, before, landed: metadata.mediaTime });
        return;
      }
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
    if (mode === "fast" && video.fastSeek) video.fastSeek(target);
    else video.currentTime = target;
  });
})`;

async function launch(context: FixtureContext, userDataDir: string): Promise<Launched> {
  const spawnedAt = Date.now();

  const app = await electron.launch({
    args: [path.join(appDir, ".vite/build/main.cjs"), `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: context.env,
    executablePath: path.join(appDir, "node_modules/electron/dist", binary),
  });

  const windowsBeforeProbe = app.windows().length;

  await app.context().addInitScript(PAGE_PROBE);

  const page = await mainWindow(app);

  // Already open before the init script went in: install it now (it is idempotent).
  await page.evaluate(PAGE_PROBE);

  return { app, page, spawnedAt, windowsBeforeProbe };
}

/** Oriel's main window, by its page (Tidy can open a hidden transcoder window beside it). */
async function mainWindow(app: ElectronApplication): Promise<Page> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const page = app.windows().find((candidate) => candidate.url().endsWith("index.html"));

    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Oriel's main window never opened");
}

/** Sizes the window's content, stubs the folder dialog with `folder`, and brings it forward. */
async function prepareWindow(app: ElectronApplication, folder: string | null): Promise<void> {
  await app.evaluate(
    ({ app: electronApp, BrowserWindow, dialog }, { chosen, size }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith("index.html"),
      );

      if (size) window?.setContentSize(size.width, size.height);

      if (chosen) {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
      }

      window?.show();
      window?.focus();
      electronApp.focus({ steal: true });
    },
    { chosen: folder, size: VIEWPORT },
  );
}

async function waitForFirstThumbnails(page: Page, timeout: number): Promise<FirstThumbnails> {
  try {
    const handle = await page.waitForFunction("window.__framePerf.firstThumbnails", undefined, {
      timeout,
      polling: 50,
    });

    return FirstThumbnailsSchema.parse(await handle.jsonValue());
  } catch (error) {
    // What the gallery showed instead, to tell a probe that missed from a gallery that never drew.
    emit("first-thumbnails-missing", {
      gallery: await page.evaluate(`(() => {
        const state = window.__framePerf;
        const tiles = state ? state.visibleTiles() : [];
        return {
          probe: Boolean(state),
          tiles: document.querySelectorAll("[data-gallery-item]").length,
          visible: tiles.length,
          drawn: tiles.filter((tile) => {
            const image = tile.querySelector("img");
            return image && image.complete && image.naturalWidth > 0;
          }).length,
          header: document.querySelector("header")?.innerText ?? null,
        };
      })()`),
    });
    throw error;
  }
}

/** Waits until the header counts `count` items and no scan is running; returns when that was. */
async function waitForListed(page: Page, count: number, timeout: number): Promise<number> {
  await page.getByText(`${count} items`, { exact: true }).first().waitFor({ timeout });
  await page
    .getByText(/Scanning|Checking folder contents/)
    .first()
    .waitFor({ state: "hidden", timeout });

  return Date.now();
}

async function thumbnailDiagnostics(page: Page): Promise<z.infer<typeof ThumbnailStateSchema>> {
  const state = await page.evaluate(`(async () => {
    const result = await window.frameView.debug.getDiagnosticsSnapshot();
    if (!('value' in result)) throw new Error('Diagnostics unavailable');
    const t = result.value.thumbnails;
    return {
      abortedCount: t.abortedCount, diskCacheHits: t.diskCacheHits,
      generatedCount: t.generatedCount, imageQueueDepth: t.imageQueueDepth,
      inflightRequests: t.inflightRequests, memoryCacheHits: t.memoryCacheHits,
      imageWorkerCount: t.imageWorkerCount, videoQueueDepth: t.videoQueueDepth,
    };
  })()`);

  return ThumbnailStateSchema.parse(state);
}

/** Waits (up to `timeout`) until no thumbnail is queued or in flight. */
async function waitForThumbnailsIdle(page: Page, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const state = await thumbnailDiagnostics(page);

    if (state.imageQueueDepth === 0 && state.inflightRequests === 0 && state.videoQueueDepth === 0)
      return true;

    await page.waitForTimeout(500);
  }

  return false;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;

  return sorted[Math.round((sorted.length - 1) * fraction)] ?? 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The same statistics as Oriel GPUI's `frame_stats`: intervals, percentiles, long frames. */
function frameStats(times: number[]) {
  const intervals = times
    .slice(1)
    .map((time, index) => time - (times[index] ?? time))
    .sort((a, b) => a - b);

  const p50 = percentile(intervals, 0.5);

  return {
    frames: times.length,
    durationS: round2(((times.at(-1) ?? 0) - (times[0] ?? 0)) / 1000),
    p50Ms: round2(p50),
    p95Ms: round2(percentile(intervals, 0.95)),
    p99Ms: round2(percentile(intervals, 0.99)),
    maxMs: round2(intervals.at(-1) ?? 0),
    longFrames: intervals.filter((interval) => interval > p50 * 1.5).length,
  };
}

async function scroll(page: Page) {
  const result = ScrollResultSchema.parse(
    await page.evaluate(`${PAGE_SCROLL}(${SCROLL_PX_PER_S})`),
  );

  return {
    pxPerS: SCROLL_PX_PER_S,
    distancePx: result.distance,
    columns: result.columns,
    rowStride: result.rowStride,
    viewport: result.viewport,
    ...frameStats(result.now),
    rafTimestamps: frameStats(result.stamps),
  };
}

/** Every process in the tree under `rootPid`, the root included. */
async function processTree(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="]);
  const children = new Map<number, number[]>();

  for (const line of stdout.trim().split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);

    if (pid === undefined || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }

  const tree = [rootPid];

  for (let index = 0; index < tree.length; index++) {
    tree.push(...(children.get(tree[index] ?? -1) ?? []));
  }

  return tree;
}

/** `ps` CPU time, `[[dd-]hh:]mm:ss.cc`, in seconds. */
function cpuTimeSeconds(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];

  return (rest ?? "")
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, Number(days) * 86400);
}

async function sampleProcesses(pids: number[]): Promise<ProcessSample[]> {
  const { stdout } = await execFileAsync("ps", [
    "-o",
    "pid=,rss=,time=,comm=",
    "-p",
    pids.join(","),
  ]).catch(() => ({ stdout: "" }));

  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [pid, rss, time, ...command] = line.trim().split(/\s+/);

      return {
        pid: Number(pid),
        rssKiB: Number(rss),
        cpuSeconds: cpuTimeSeconds(time ?? "0"),
        command: path.basename(command.join(" ")),
      };
    });
}

/** Physical footprint per process (what Activity Monitor shows), from macOS's `footprint`. */
async function footprints(pids: number[]): Promise<Map<number, number>> {
  const args = ["--format", "bytes", "--noCategories", ...pids.flatMap((pid) => ["-p", `${pid}`])];

  const { stdout } = await execFileAsync("footprint", args, { maxBuffer: 1 << 24 }).catch(() => ({
    stdout: "",
  }));

  const found = new Map<number, number>();

  for (const match of stdout.matchAll(/\[(\d+)\]: \S+\s+Footprint: (\d+) B/g)) {
    found.set(Number(match[1]), Number(match[2]));
  }

  return found;
}

async function memory(app: ElectronApplication) {
  const pids = await processTree(app.process().pid ?? -1);

  const [samples, footprint, metrics] = await Promise.all([
    sampleProcesses(pids),
    footprints(pids),
    app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((metric) => ({
        type: metric.type,
        workingSetKiB: metric.memory.workingSetSize,
        privateKiB: metric.memory.privateBytes ?? 0,
      })),
    ),
  ]);

  const residentMb = samples.reduce((total, sample) => total + sample.rssKiB * 1024, 0) / 1e6;
  const footprintMb = [...footprint.values()].reduce((total, bytes) => total + bytes, 0) / 1e6;

  return {
    processes: samples.length,
    residentMb: round2(residentMb),
    footprintMb: round2(footprintMb),
    perProcess: samples.map((sample) => ({
      command: sample.command,
      residentMb: round2((sample.rssKiB * 1024) / 1e6),
      footprintMb: round2((footprint.get(sample.pid) ?? 0) / 1e6),
    })),
    appMetricsWorkingSetMb: round2(
      metrics.reduce((total, metric) => total + metric.workingSetKiB * 1024, 0) / 1e6,
    ),
    appMetricsPrivateMb: round2(
      metrics.reduce((total, metric) => total + metric.privateKiB * 1024, 0) / 1e6,
    ),
  };
}

async function cpuSnapshot(app: ElectronApplication): Promise<CpuSnapshot> {
  const samples = await sampleProcesses(await processTree(app.process().pid ?? -1));

  return {
    at: performance.now(),
    cpu: new Map(samples.map((sample) => [sample.pid, sample.cpuSeconds])),
  };
}

/** Mean CPU between two snapshots, summed over processes, in percent of one core. */
function cpuPercent(from: CpuSnapshot, to: CpuSnapshot) {
  let seconds = 0;

  for (const [pid, cpu] of to.cpu) seconds += cpu - (from.cpu.get(pid) ?? 0);

  const windowS = (to.at - from.at) / 1000;

  return { windowS: round2(windowS), cpuPercent: round2((seconds / windowS) * 100) };
}

/** A fresh userData; Open on the stills with recursive on; the scan; one scroll that fills. */
async function openPhase(context: FixtureContext): Promise<void> {
  const userDataDir = path.join(context.work, "user-open");

  await rm(userDataDir, { recursive: true, force: true });

  const { app, page, spawnedAt, windowsBeforeProbe } = await launch(context, userDataDir);

  try {
    await page.getByRole("button", { name: "Open", exact: true }).waitFor({ timeout: 60_000 });
    await prepareWindow(app, path.join(context.root, "stills"));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const recursiveDefault = page.getByLabel("Enable recursive mode by default", { exact: true });

    if (!(await recursiveDefault.isChecked())) await recursiveDefault.click();
    await page.getByRole("button", { name: "Back to View" }).click();
    // Open lists the folder's children (the rolls, which have no thumbnails); the setting only
    // applies from the next launch, so Recursive is pressed as a person would.
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const openedAt = z.number().parse(await page.evaluate("window.__framePerf.lastClickAt"));

    await page.getByRole("button", { name: "Recursive", exact: true }).click();
    const recursiveAt = z.number().parse(await page.evaluate("window.__framePerf.lastClickAt"));
    const first = await waitForFirstThumbnails(page, 300_000);
    const listedAt = await waitForListed(page, context.stills, 600_000);
    const pageOrigin = first.epochMs - first.pageMs;

    emit("open-first-thumbnails", {
      round: context.round,
      sinceRecursiveMs: round2(first.pageMs - recursiveAt),
      sinceOpenMs: round2(first.pageMs - openedAt),
      sinceSpawnMs: round2(first.epochMs - spawnedAt),
      tiles: first.tiles,
      viewport: first.viewport,
      windowsBeforeProbe,
      probeInstalledMs: round2(first.probeInstalledMs),
      lastThumbnailArrivedMs: first.lastThumbnailArrivedMs && round2(first.lastThumbnailArrivedMs),
      listedSinceRecursiveMs: round2(listedAt - (pageOrigin + recursiveAt)),
      thumbnails: await thumbnailDiagnostics(page),
    });

    await page.waitForTimeout(2000);
    emit("open-scroll", { round: context.round, ...(await scroll(page)) });
    const idle = await waitForThumbnailsIdle(page, 120_000);

    emit("open-filled", {
      round: context.round,
      idle,
      thumbnails: await thumbnailDiagnostics(page),
      memory: await memory(app),
    });
  } finally {
    await app.close();
  }
}

/** A fresh userData seeded with `open`'s settings and window state: the folder opens at launch. */
async function coldStartPhase(context: FixtureContext): Promise<void> {
  const userDataDir = path.join(context.work, "user-coldstart");
  const opened = path.join(context.work, "user-open");

  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(path.join(userDataDir, "frame-view"), { recursive: true });
  await copyFile(
    path.join(opened, "frame-view", "frame-view-settings.json"),
    path.join(userDataDir, "frame-view", "frame-view-settings.json"),
  );
  await copyFile(
    path.join(opened, "window-state.json"),
    path.join(userDataDir, "window-state.json"),
  );

  const { app, page, spawnedAt, windowsBeforeProbe } = await launch(context, userDataDir);

  try {
    const first = await waitForFirstThumbnails(page, 300_000);
    const listedAt = await waitForListed(page, context.stills, 600_000);

    emit("coldstart-first-thumbnails", {
      round: context.round,
      sinceSpawnMs: round2(first.epochMs - spawnedAt),
      sinceNavigationMs: round2(first.pageMs),
      tiles: first.tiles,
      viewport: first.viewport,
      windowsBeforeProbe,
      probeInstalledMs: round2(first.probeInstalledMs),
      lastThumbnailArrivedMs: first.lastThumbnailArrivedMs && round2(first.lastThumbnailArrivedMs),
      listedSinceSpawnMs: listedAt - spawnedAt,
      thumbnails: await thumbnailDiagnostics(page),
    });
  } finally {
    await app.close();
  }
}

/** `coldstart`'s userData again (its first screen cached): a warm launch, then settled idle. */
async function warmStartPhase(context: FixtureContext): Promise<void> {
  const userDataDir = path.join(context.work, "user-coldstart");
  const { app, page, spawnedAt, windowsBeforeProbe } = await launch(context, userDataDir);

  try {
    const first = await waitForFirstThumbnails(page, 300_000);
    const firstSeenAt = Date.now();

    emit("warmstart-first-thumbnails", {
      round: context.round,
      sinceSpawnMs: round2(first.epochMs - spawnedAt),
      sinceNavigationMs: round2(first.pageMs),
      tiles: first.tiles,
      viewport: first.viewport,
      windowsBeforeProbe,
      probeInstalledMs: round2(first.probeInstalledMs),
      thumbnails: await thumbnailDiagnostics(page),
    });

    const listedAt = await waitForListed(page, context.stills, 600_000);
    const thumbnailsIdle = await waitForThumbnailsIdle(page, 120_000);

    await page.waitForTimeout(Math.max(0, firstSeenAt + SETTLE_MS - Date.now()));
    const from = await cpuSnapshot(app);

    await page.waitForTimeout(Math.max(0, firstSeenAt + REST_MS - Date.now()));
    const at60 = await memory(app);

    await page.waitForTimeout(Math.max(0, firstSeenAt + SETTLE_MS + REST_MS - Date.now()));
    const to = await cpuSnapshot(app);

    emit("idle", {
      round: context.round,
      listedSinceSpawnMs: listedAt - spawnedAt,
      thumbnailsIdle,
      ...cpuPercent(from, to),
      memoryAt60s: at60,
      memoryAt90s: await memory(app),
    });
  } finally {
    await app.close();
  }
}

/** `open`'s userData again: first thumbnails, rest, scroll, rest, viewer steps, video. */
async function warmPhase(context: FixtureContext): Promise<void> {
  const userDataDir = path.join(context.work, "user-open");
  const { app, page, spawnedAt, windowsBeforeProbe } = await launch(context, userDataDir);

  try {
    const first = await waitForFirstThumbnails(page, 300_000);
    const restFrom = await cpuSnapshot(app);
    const firstSeenAt = Date.now();

    emit("warm-first-thumbnails", {
      round: context.round,
      sinceSpawnMs: round2(first.epochMs - spawnedAt),
      sinceNavigationMs: round2(first.pageMs),
      tiles: first.tiles,
      viewport: first.viewport,
      windowsBeforeProbe,
      probeInstalledMs: round2(first.probeInstalledMs),
      lastThumbnailArrivedMs: first.lastThumbnailArrivedMs && round2(first.lastThumbnailArrivedMs),
      thumbnails: await thumbnailDiagnostics(page),
    });

    const listedAt = await waitForListed(page, context.stills, 600_000);

    emit("warm-listed", { round: context.round, sinceSpawnMs: listedAt - spawnedAt });
    await page.waitForTimeout(Math.max(0, firstSeenAt + REST_MS - Date.now()));
    const restTo = await cpuSnapshot(app);

    emit("rest", {
      round: context.round,
      ...cpuPercent(restFrom, restTo),
      memory: await memory(app),
    });

    await prepareWindow(app, null);
    const refreshMs = z.number().parse(await page.evaluate(PAGE_REFRESH));
    const before = await thumbnailDiagnostics(page);
    const scrolled = await scroll(page);
    const afterFrom = await cpuSnapshot(app);

    emit("scroll", {
      round: context.round,
      refreshMs: round2(refreshMs),
      ...scrolled,
      thumbnailsBefore: before,
      thumbnailsAfter: await thumbnailDiagnostics(page),
    });

    await page.waitForTimeout(REST_MS);
    const afterTo = await cpuSnapshot(app);

    emit("after-scroll", {
      round: context.round,
      ...cpuPercent(afterFrom, afterTo),
      memory: await memory(app),
    });

    for (const [pace, gap] of [
      ["steady", 500],
      ["rapid", 100],
    ] as const) {
      emit("steps", { round: context.round, pace, ...(await viewerSteps(app, page, gap)) });
    }

    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.setAudioMuted(true);
    });

    for (const codec of VIDEO_CODECS) {
      emit("video", {
        round: context.round,
        codec,
        ...(await videos(app, page, path.join(context.root, "videos", codec))),
      });
    }

    emit("done", { round: context.round, memory: await memory(app) });
  } finally {
    await app.close();
  }
}

/**
 * Opens the viewer on the gallery's first still and presses → every `gap` ms until 20 steps have
 * landed on an AVIF and 20 on a JPEG; each step is timed from the keydown to the frame begun once
 * the full still is loaded and decoded.
 */
async function viewerSteps(app: ElectronApplication, page: Page, gap: number) {
  await prepareWindow(app, null);
  await page.locator("[data-gallery-scroll-container]").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(1000);
  await page.locator("[data-gallery-item]").first().dblclick();
  await page.locator("dialog[open]").waitFor();
  await page.waitForTimeout(800);
  await page.evaluate("window.__framePerf.startSteps()");

  const formatOf = (name: string) => (/\.avif$/i.test(name) ? "avif" : "jpeg");
  const Attempts = z.array(StepAttemptSchema);

  for (let press = 0; press < 200; press++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(gap);

    const attempts = Attempts.parse(await page.evaluate("window.__framePerf.steps.attempts"));
    const counts = { avif: 0, jpeg: 0 };

    for (const attempt of attempts) counts[formatOf(attempt.name)] += 1;

    if (counts.avif >= STEPS_PER_FORMAT && counts.jpeg >= STEPS_PER_FORMAT) break;
  }

  await page.waitForTimeout(500);

  const attempts = Attempts.parse(await page.evaluate("window.__framePerf.stopSteps()"));

  await page.keyboard.press("Escape");
  await page.locator("dialog[open]").waitFor({ state: "detached" });

  const summarise = (format: "avif" | "jpeg") => {
    const asked = attempts
      .filter((attempt) => formatOf(attempt.name) === format)
      .slice(0, STEPS_PER_FORMAT);

    const drawn = asked
      .map((attempt) => attempt.ms)
      .filter((ms) => ms !== null)
      .sort((a, b) => a - b);

    return {
      asked: asked.length,
      drawn: drawn.length,
      p50Ms: round2(percentile(drawn, 0.5)),
      p95Ms: round2(percentile(drawn, 0.95)),
      maxMs: round2(drawn.at(-1) ?? 0),
      widths: [...new Set(asked.map((attempt) => attempt.width))],
    };
  };

  return { avif: summarise("avif"), jpeg: summarise("jpeg") };
}

/**
 * Opens `folder` (one codec's videos), and for its first ten tiles times the double click to the
 * viewer's first frame, then an exact seek to half its length and a fast seek to a quarter, as
 * Oriel GPUI's `video_spike sweep` does.
 */
async function videos(app: ElectronApplication, page: Page, folder: string) {
  await prepareWindow(app, folder);
  await page.getByRole("button", { name: "Open", exact: true }).click();

  const count = (await readdir(folder)).filter((name) => !name.startsWith(".")).length;

  await waitForListed(page, count, 120_000);

  const postersIdle = await waitForThumbnailsIdle(page, 120_000);

  await page.waitForTimeout(2000);

  const rows = [];
  const tiles = page.locator("[data-gallery-item]");

  for (let index = 0; index < VIDEOS_PER_CODEC; index++) {
    const tile = tiles.nth(index);
    const name = (await tile.getAttribute("data-gallery-item-id")) ?? "";

    await page.evaluate(PAGE_VIDEO_PROBE);
    await tile.dblclick();

    const open = VideoFirstFrameSchema.parse(
      await page
        .waitForFunction("window.__framePerf.video.first", undefined, { timeout: 15_000 })
        .then((handle) => handle.jsonValue())
        .catch(() => null),
    );

    await page.waitForTimeout(300);

    const exact = SeekSchema.parse(
      await page.evaluate(`${PAGE_SEEK}({ share: 0.5, mode: "exact" })`),
    );

    await page.waitForTimeout(200);

    const fast = SeekSchema.parse(
      await page.evaluate(`${PAGE_SEEK}({ share: 0.25, mode: "fast" })`),
    );

    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    rows.push({ name: path.basename(name.replace(/:\d+:\d+$/, "")), open, exact, fast });
  }

  const median = (values: (number | null)[]) =>
    round2(
      percentile(
        values.filter((value) => value !== null).sort((a, b) => a - b),
        0.5,
      ),
    );

  return {
    postersIdle,
    files: rows.length,
    openMedianMs: median(rows.map((row) => row.open?.ms ?? null)),
    exactMedianMs: median(rows.map((row) => row.exact.ms)),
    fastMedianMs: median(rows.map((row) => row.fast.ms)),
    rows,
  };
}

// Last, so every constant above is initialised before a run reads it.
const fixtureRoot = process.env.FRAME_PERF_FIXTURE_ROOT;

if (fixtureRoot) {
  await runFixture(fixtureRoot);
} else {
  await runSynthetic();
}
