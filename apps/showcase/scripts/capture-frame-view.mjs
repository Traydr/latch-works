#!/usr/bin/env node
/**
 * Captures real Frame View screenshots for the showcase site.
 *
 * Launches the actual Electron app with remote debugging enabled, connects via
 * puppeteer-core, and captures gallery/viewer/settings at 1440x900 @2x (dark).
 *
 * The user's Frame View settings file is backed up before launch and restored
 * byte-identical after the app quits (the app rewrites the file on exit).
 *
 * Usage: node apps/showcase/scripts/capture-frame-view.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const repoRoot = join(root, "../..");

const outputDir = join(root, "public", "screenshots", "frame-view");

const showcaseMediaDir = join(repoRoot, "apps/frame-view/showcase-media");

const settingsPath = join(
  homedir(),
  "Library/Application Support/Frame View/frame-view-settings.json",
);

const settingsBackupPath = `${settingsPath}.showcase-backup`;

const debugPort = Number(process.env.FRAME_VIEW_DEBUG_PORT ?? 9223);

const debugBase = `http://127.0.0.1:${debugPort}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function debugPortIsUp() {
  try {
    const response = await fetch(`${debugBase}/json/version`);

    return response.ok;
  } catch {
    return false;
  }
}

function writeShowcaseSettings() {
  const original = JSON.parse(readFileSync(settingsPath, "utf8"));

  const showcase = {
    ...original,
    settings: {
      ...original.settings,
      theme: "dark",
      rememberLastFolder: true,
      recursiveDefault: false,
      sortMode: "name-asc",
      rootGalleryPreferences: {},
      lastFolderPath: showcaseMediaDir,
    },
    windowBounds: { x: 80, y: 60, width: 1440, height: 900 },
    windowMaximized: false,
  };

  writeFileSync(settingsPath, `${JSON.stringify(showcase, null, 2)}\n`);
}

function startFrameView() {
  const child = spawn(
    "pnpm",
    ["--filter", "@latch-works/frame-view", "start", "--", `--remote-debugging-port=${debugPort}`],
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

async function waitForDebugPort(app, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (app.child.exitCode !== null) {
      throw new Error(`Frame View exited before debug port came up:\n${app.getOutput()}`);
    }

    if (await debugPortIsUp()) {
      return;
    }

    await sleep(1000);
  }

  throw new Error(`Debug port ${debugPort} not reachable in time:\n${app.getOutput()}`);
}

async function connectToAppPage() {
  const browser = await puppeteer.connect({ browserURL: debugBase, defaultViewport: null });
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const appPage = pages.find((page) => !page.url().startsWith("devtools://"));

    if (appPage) {
      return { browser, page: appPage };
    }

    await sleep(500);
  }

  await browser.disconnect();
  throw new Error("No Frame View app page found among debugger targets");
}

async function waitForGallery(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('[data-gallery-item="true"]').length >= 8,
    { timeout: 60_000 },
  );

  try {
    await page.waitForFunction(
      () => {
        const images = [...document.querySelectorAll('[data-gallery-item="true"] img')];

        return (
          images.length >= 8 && images.every((image) => image.complete && image.naturalWidth > 0)
        );
      },
      { timeout: 30_000 },
    );
  } catch {
    console.warn("Thumbnail <img> readiness check timed out; continuing after a grace period.");
  }

  await sleep(3000);
}

/**
 * The grid can render the initial scan in filesystem order; re-picking A-Z in
 * the real sort menu forces the store to re-sort before the gallery shot.
 */
async function reapplyNameSort(page) {
  const pickSortOption = async (label) => {
    await page.click('button[aria-haspopup="menu"]');
    await sleep(300);

    const picked = await page.evaluate((optionLabel) => {
      const option = [...document.querySelectorAll('[role="menuitemradio"]')].find(
        (button) => button.textContent?.trim().replace("•", "").trim() === optionLabel,
      );

      option?.click();

      return Boolean(option);
    }, label);

    await sleep(500);

    return picked;
  };

  if (!(await pickSortOption("Z-A")) || !(await pickSortOption("A-Z"))) {
    throw new Error("Could not select name order in the sort menu");
  }
}

async function saveScreenshot(page, name) {
  const path = join(outputDir, name);
  await page.screenshot({ path, type: "png" });
  console.log(`Saved ${path}`);
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

  console.warn("Frame View did not shut down cleanly; sending SIGKILL.");

  try {
    process.kill(-app.child.pid, "SIGKILL");
  } catch {
    // Process group already gone.
  }

  await sleep(2000);
}

function restoreSettings(originalSettings) {
  writeFileSync(settingsPath, originalSettings);
  const restored = readFileSync(settingsPath);
  console.log(`Settings SHA-256 after: ${createHash("sha256").update(restored).digest("hex")}`);
  if (!restored.equals(originalSettings)) {
    throw new Error(`Settings restoration failed; backup is at ${settingsBackupPath}`);
  }
  console.log("Restored original settings byte-identical.");
}

async function main() {
  if (!existsSync(settingsPath)) {
    throw new Error(`Frame View settings not found at ${settingsPath}`);
  }

  if (!existsSync(showcaseMediaDir)) {
    throw new Error(`Showcase media folder missing at ${showcaseMediaDir}`);
  }

  if (await debugPortIsUp()) {
    throw new Error(`Port ${debugPort} already serving CDP. Quit the running Frame View first.`);
  }

  mkdirSync(outputDir, { recursive: true });
  const originalSettings = readFileSync(settingsPath);
  const originalHash = createHash("sha256").update(originalSettings).digest("hex");
  console.log(`Settings SHA-256 before: ${originalHash}`);
  copyFileSync(settingsPath, settingsBackupPath);
  console.log(`Backed up settings to ${settingsBackupPath}`);

  let app = null;
  let browser = null;

  try {
    writeShowcaseSettings();
    app = startFrameView();
    console.log("Waiting for Frame View to boot (prestart can take a while)...");
    await waitForDebugPort(app);

    const connection = await connectToAppPage();
    browser = connection.browser;
    const page = connection.page;

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.bringToFront();

    await waitForGallery(page);
    await reapplyNameSort(page);
    await saveScreenshot(page, "gallery.png");

    // sample-09 is a vivid tile; the earliest samples are near-black and make a
    // dull viewer shot.
    const tiles = await page.$$('[data-gallery-item="true"]');
    const viewerTile = tiles[8] ?? tiles[0];

    if (!viewerTile) {
      throw new Error("No gallery tile found for the viewer screenshot");
    }

    await viewerTile.click({ count: 2 });
    await page.waitForSelector('dialog[open][aria-label^="Viewer for"]', { visible: true });
    await sleep(1500);
    // Real pointer movement reveals the auto-hiding title bar and step arrows.
    await page.mouse.move(720, 120);
    await page.waitForFunction(() => {
      const labels = [
        "Copy path",
        "Reveal in folder",
        "Fullscreen",
        "Close",
        "Previous item",
        "Next item",
      ];
      return labels.every((label) => {
        const button = document.querySelector(`button[aria-label="${label}"]`);
        if (!button || button.disabled) return false;
        for (let element = button; element; element = element.parentElement) {
          if (Number(getComputedStyle(element).opacity) < 1) return false;
        }
        return true;
      });
    });
    await saveScreenshot(page, "viewer.png");
    await page.keyboard.press("Escape");
    await sleep(600);

    const openedSettings = await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((element) =>
        element.textContent?.trim().includes("Settings"),
      );

      button?.click();

      return Boolean(button);
    });

    if (!openedSettings) {
      throw new Error("Settings button not found in the toolbar");
    }

    await page.waitForSelector('aside[aria-label="Preferences"]', { visible: true });
    await sleep(1000);
    await saveScreenshot(page, "settings.png");
  } finally {
    try {
      if (browser) {
        await browser.disconnect().catch(() => {});
      }
    } finally {
      try {
        if (app) {
          await shutDownApp(app);
        }
      } finally {
        restoreSettings(originalSettings);
      }
    }
  }

  console.log("Frame View capture complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
