#!/usr/bin/env node
/**
 * Captures real Oriel screenshots for the showcase site: View's gallery, viewer and settings,
 * Tidy's overview, and Sync's plan and push, at 1440x900 @2x (dark).
 *
 * Launches the actual Electron app with remote debugging on a throwaway data folder, seeded with
 * View's settings (the showcase archive's photos as the last folder) and one Sync profile for the
 * showcase archive. Your own folders, catalogs, profiles and tokens are never touched. It switches
 * modes from the switcher, as the owner does.
 *
 * Requirements before running:
 * - The showcase archive at /tmp/showcase-archive (node scripts/prepare-showcase-media.mjs).
 * - For Sync, a Pane View server: http://localhost:3000 with PANE_VIEW_SYNC_TOKEN in the repo
 *   root .env, or SHOWCASE_PANE_VIEW_URL and SHOWCASE_SYNC_TOKEN naming another one (the e2e
 *   suite's, say). The push uploads the archive's sample scans to that server.
 *
 * Usage: node apps/showcase/scripts/capture-oriel.mjs [view] [tidy] [sync]   (all three by default)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { assertShowcaseArchive, showcaseArchiveDir } from "./showcase-archive.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const repoRoot = join(root, "../..");

const screenshotsDir = join(root, "public", "screenshots");

const photosDir = join(showcaseArchiveDir, "sfw/photos");

const scansDir = join(showcaseArchiveDir, "sfw/scans");

const apiUrl = process.env.SHOWCASE_PANE_VIEW_URL ?? "http://localhost:3000";

const debugPort = Number(process.env.ORIEL_DEBUG_PORT ?? 9225);

const debugBase = `http://127.0.0.1:${debugPort}`;

const require = createRequire(join(repoRoot, "apps/oriel/package.json"));

const sharp = require("sharp");

const sections = new Set(
  process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["view", "tidy", "sync"],
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSyncToken() {
  if (process.env.SHOWCASE_SYNC_TOKEN) {
    return process.env.SHOWCASE_SYNC_TOKEN;
  }

  const envPath = join(repoRoot, ".env");

  const match = existsSync(envPath)
    ? readFileSync(envPath, "utf8").match(/^PANE_VIEW_SYNC_TOKEN=(.+)$/m)
    : null;

  const token = match?.[1]?.trim().replace(/^["']|["']$/g, "");

  if (!token) {
    throw new Error("Set SHOWCASE_SYNC_TOKEN, or PANE_VIEW_SYNC_TOKEN in the repo root .env");
  }

  return token;
}

async function assertServerIsUp() {
  try {
    await fetch(apiUrl);
  } catch {
    throw new Error(`Pane View server is not reachable at ${apiUrl}. Start it first.`);
  }
}

async function debugPortIsUp() {
  try {
    const response = await fetch(`${debugBase}/json/version`);

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Writes six distinct sample scans. Regenerated on every run (random mosaic tiles) so a rerun
 * after a successful push still plans real uploads and updates.
 */
async function seedScanImages() {
  mkdirSync(scansDir, { recursive: true });
  const accents = ["#8b5cf6", "#3b82f6", "#10b981", "#f59e0b", "#f43f5e", "#38bdf8"];

  for (let index = 0; index < 6; index += 1) {
    const label = String(index + 1).padStart(2, "0");
    const tiles = [];

    for (let row = 0; row < 18; row += 1) {
      for (let col = 0; col < 24; col += 1) {
        const shade = 24 + Math.floor(Math.random() * 48);
        tiles.push(
          `<rect x="${col * 100}" y="${row * 100}" width="100" height="100" ` +
            `fill="rgb(${shade},${shade},${shade + 6})"/>`,
        );
      }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1800">
      ${tiles.join("\n")}
      <rect x="120" y="120" width="2160" height="1560" rx="64" fill="${accents[index]}" opacity="0.18"/>
      <text x="1200" y="930" text-anchor="middle" fill="#f4f4f5" font-family="Segoe UI, system-ui, sans-serif" font-size="180" font-weight="600">Scan ${label}</text>
    </svg>`;

    writeFileSync(
      join(scansDir, `scan-${label}.jpg`),
      await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer(),
    );
  }

  console.log(`Seeded 6 scan images in ${scansDir}`);
}

/**
 * A throwaway data folder: Oriel's modes keep their folders inside it under `--user-data-dir`.
 * View remembers the showcase photos; Sync has one token-less profile for the showcase archive,
 * so it never reads the CLI's ~/.latch-works config.
 */
function createUserDataDir() {
  const userDataDir = mkdtempSync(join(tmpdir(), "oriel-showcase-"));
  const profileId = randomUUID();

  mkdirSync(join(userDataDir, "frame-view"));
  writeFileSync(
    join(userDataDir, "frame-view", "frame-view-settings.json"),
    `${JSON.stringify(
      {
        settings: {
          rememberLastFolder: true,
          recursiveDefault: false,
          sortMode: "name-asc",
          lastFolderPath: photosDir,
        },
      },
      null,
      2,
    )}\n`,
  );

  mkdirSync(join(userDataDir, "lockstep"));
  writeFileSync(
    join(userDataDir, "lockstep", "lockstep-settings.json"),
    `${JSON.stringify(
      {
        activeProfileId: profileId,
        profiles: [{ apiUrl, id: profileId, name: "Showcase", sourceRoot: showcaseArchiveDir }],
      },
      null,
      2,
    )}\n`,
  );

  return userDataDir;
}

function startOriel(userDataDir) {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@latch-works/oriel",
      "start",
      "--",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
    ],
    { cwd: repoRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );

  child.unref();
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return { child, getOutput: () => output };
}

async function waitForDebugPort(app, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (app.child.exitCode !== null) {
      throw new Error(`Oriel exited before the debug port came up:\n${app.getOutput()}`);
    }

    if (await debugPortIsUp()) {
      return;
    }

    await sleep(1000);
  }

  throw new Error(`Debug port ${debugPort} not reachable in time:\n${app.getOutput()}`);
}

/** Oriel's window, found by its page: Tidy opens a hidden transcoder window beside it. */
async function connectToAppPage() {
  const browser = await puppeteer.connect({ browserURL: debugBase, defaultViewport: null });
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const pages = await browser.pages();

    const appPage = pages.find(
      (page) => !page.url().startsWith("devtools://") && !page.url().includes("transcoder"),
    );

    if (appPage) {
      return { browser, page: appPage };
    }

    await sleep(500);
  }

  await browser.disconnect();
  throw new Error("No Oriel window found among debugger targets");
}

/** Clicks the visible element matching `selector`; hidden modes keep copies of the switcher. */
async function clickVisible(page, selector) {
  const clicked = await page.evaluate((target) => {
    const element = [...document.querySelectorAll(target)].find(
      (candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null,
    );

    element?.click();

    return Boolean(element);
  }, selector);

  if (!clicked) {
    throw new Error(`Nothing visible matches ${selector}`);
  }
}

async function openMode(page, mode, label) {
  await clickVisible(page, `[data-mode="${mode}"]`);
  await page.waitForFunction((title) => document.title === title, {}, `${label} – Oriel`);
  await sleep(800);
}

async function saveScreenshot(page, folder, name) {
  const directory = join(screenshotsDir, folder);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  await page.screenshot({ path, type: "png" });
  console.log(`Saved ${path}`);
}

async function captureView(page) {
  await openMode(page, "view", "View");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-gallery-item="true"]').length >= 8,
    { timeout: 60_000 },
  );
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[data-gallery-item="true"] img')].every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      { timeout: 30_000 },
    )
    .catch(() => console.warn("Thumbnails were still loading; continuing after a grace period."));
  await sleep(2000);
  await saveScreenshot(page, "frame-view", "gallery.png");

  // sample-09 is a vivid tile; the earliest samples are near-black and make a dull viewer shot.
  const tiles = await page.$$('[data-gallery-item="true"]');
  const viewerTile = tiles[8] ?? tiles[0];

  if (!viewerTile) {
    throw new Error("No gallery tile for the viewer screenshot");
  }

  await viewerTile.click({ count: 2 });
  await page.waitForSelector('dialog[open][aria-label^="Viewer for"]', { visible: true });
  await sleep(1500);
  // Real pointer movement reveals the auto-hiding title bar and step arrows.
  await page.mouse.move(720, 120);
  await sleep(600);
  await saveScreenshot(page, "frame-view", "viewer.png");
  await page.keyboard.press("Escape");
  await sleep(600);

  await clickVisible(page, 'button[title="Preferences"]');
  await page.waitForSelector('button[aria-label="Close settings"]', { visible: true });
  await sleep(800);
  await saveScreenshot(page, "frame-view", "settings.png");
  await page.click('button[aria-label="Close settings"]');
  await sleep(400);
}

async function captureTidy(page) {
  await openMode(page, "tidy", "Tidy");
  await clickVisible(page, "main button.lw-btn-primary");
  await page.waitForSelector("[data-folder-path]", { visible: true });
  await page.click("[data-folder-path]", { count: 3 });
  await page.keyboard.type(`${showcaseArchiveDir}/`);
  await page.waitForFunction(
    () => document.querySelector("[data-folder-choose]")?.textContent?.includes("showcase-archive"),
    { timeout: 15_000 },
  );
  await page.click("[data-folder-choose]");

  // The scan, then background analysis: wait until no job card shows, twice in a row.
  const deadline = Date.now() + 240_000;
  let idle = 0;

  while (idle < 2 && Date.now() < deadline) {
    await sleep(1000);

    const busy = await page.evaluate(
      () => document.querySelectorAll('[data-testid="activity"][data-job-state]').length > 0,
    );

    idle = busy ? 0 : idle + 1;
  }

  await sleep(1000);
  await saveScreenshot(page, "tidy", "overview.png");
}

async function captureSync(page, token) {
  await openMode(page, "sync", "Sync");

  // The seeded profile has no saved token; enter it for the session, by the field's label.
  const tokenSelector = '::-p-xpath(//label[span[normalize-space()="Sync API token"]]//input)';
  await page.waitForSelector(tokenSelector, { timeout: 60_000 });
  await page.type(tokenSelector, token);

  await clickVisible(page, 'button[data-action="plan"]:not([disabled])');
  await page.waitForFunction(() => document.querySelector('[data-plan-count="keep"]') !== null, {
    timeout: 120_000,
  });
  await sleep(800);
  await saveScreenshot(page, "lockstep", "plan.png");

  // Local pushes of six small scans finish faster than a 2880x1800 screenshot, so capture the
  // finished run: the run panel keeps the totals and throughput, the tree each row's result.
  await clickVisible(page, 'button[data-action="push"]:not([disabled])');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("span")].some((span) => span.textContent === "Push complete"),
    { timeout: 180_000 },
  );
  await sleep(800);
  await saveScreenshot(page, "lockstep", "push.png");
}

async function shutDownApp(app) {
  try {
    process.kill(-app.child.pid, "SIGTERM");
  } catch {
    // Process group already gone.
  }

  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (!(await debugPortIsUp())) {
      await sleep(2000);

      return;
    }

    await sleep(500);
  }

  console.warn("Oriel did not shut down cleanly; sending SIGKILL.");

  try {
    process.kill(-app.child.pid, "SIGKILL");
  } catch {
    // Process group already gone.
  }
}

async function main() {
  assertShowcaseArchive(showcaseArchiveDir);

  const token = sections.has("sync") ? readSyncToken() : null;

  if (sections.has("sync")) {
    await assertServerIsUp();
    await seedScanImages();
  }

  if (await debugPortIsUp()) {
    throw new Error(`Port ${debugPort} already serving CDP. Quit the running Oriel first.`);
  }

  const userDataDir = createUserDataDir();
  let app = null;
  let browser = null;

  try {
    app = startOriel(userDataDir);
    console.log("Waiting for Oriel to boot (prestart can take a while)...");
    await waitForDebugPort(app);

    const connection = await connectToAppPage();
    browser = connection.browser;
    const page = connection.page;

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.bringToFront();
    await page.waitForSelector("[data-mode]", { timeout: 60_000 });

    if (sections.has("view")) {
      await captureView(page);
    }

    if (sections.has("tidy")) {
      await captureTidy(page);
    }

    if (sections.has("sync") && token) {
      await captureSync(page, token);
    }
  } finally {
    if (browser) {
      await browser.disconnect().catch(() => {});
    }

    if (app) {
      await shutDownApp(app);
    }

    rmSync(userDataDir, { force: true, recursive: true });
  }

  console.log("Oriel capture complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
