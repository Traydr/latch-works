#!/usr/bin/env node
/**
 * Captures real Pane View screenshots (login, gallery, viewer) for the showcase site.
 * Requires the Pane View dev server to be running (default http://localhost:3000).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "../..");
const outputDir = join(root, "public", "screenshots", "pane-view");
const paneBase = (process.env.PANE_VIEW_URL ?? "http://localhost:3000").replace(/\/$/, "");
const galleryPath = process.env.PANE_VIEW_GALLERY_PATH ?? "sfw/photos";
const expectedThumbnails = Number(process.env.PANE_VIEW_EXPECTED_THUMBNAILS ?? "18");

function loadRepoEnv() {
  for (const envPath of [join(root, ".env"), join(repoRoot, ".env")]) {
    if (!existsSync(envPath)) {
      continue;
    }

    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

loadRepoEnv();

const username = process.env.PANE_VIEW_USERNAME;
const password = process.env.PANE_VIEW_PASSWORD;
if (!username || !password) {
  console.error("PANE_VIEW_USERNAME / PANE_VIEW_PASSWORD not set (checked env and repo .env).");
  process.exit(1);
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  join(
    root,
    "chrome/mac_arm-149.0.7827.115/chrome-mac-arm64",
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ),
].filter(Boolean);
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error(`Chrome not found. Tried:\n  ${chromeCandidates.join("\n  ")}\nSet CHROME_PATH.`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkHealth() {
  try {
    const response = await fetch(`${paneBase}/api/health`);
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
  } catch (error) {
    throw new Error(`Pane View is not reachable at ${paneBase}/api/health (${error.message}).`);
  }
}

/**
 * The app reads the theme from `pane-view.settings` (ThemeSync) and next-themes
 * persists its own `theme` key; prime both before any page script runs so the
 * first paint is already dark.
 */
async function primeDarkTheme(page) {
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await page.evaluateOnNewDocument(() => {
    window.localStorage.setItem("theme", "dark");
    const raw = window.localStorage.getItem("pane-view.settings");
    let settings = {};
    try {
      settings = raw ? JSON.parse(raw) : {};
    } catch {
      settings = {};
    }
    window.localStorage.setItem(
      "pane-view.settings",
      JSON.stringify({ ...settings, theme: "dark" }),
    );
  });
}

async function login(page) {
  await page.goto(`${paneBase}/login`, { waitUntil: "networkidle2", timeout: 60_000 });
  await page.waitForSelector("#username", { timeout: 15_000 });
  await page.type("#username", username);
  await page.type("#password", password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function captureLogin(page) {
  await page.goto(`${paneBase}/login`, { waitUntil: "networkidle2", timeout: 60_000 });
  await page.waitForSelector("#username", { timeout: 15_000 });
  await sleep(500);
  const path = join(outputDir, "login.png");
  await page.screenshot({ path, type: "png" });
  console.log(`Saved ${path}`);
}

async function captureGallery(page) {
  await page.goto(`${paneBase}/?path=${encodeURIComponent(galleryPath)}`, {
    waitUntil: "networkidle2",
    timeout: 60_000,
  });

  // Thumbnails resolve in batches to presigned URLs; wait until enough <img>
  // elements have actually decoded (placeholders render as bare divs).
  try {
    await page.waitForFunction(
      (expected) => {
        const images = [...document.querySelectorAll("main img, [data-slot] img, img")];
        const loaded = images.filter((img) => img.complete && img.naturalWidth > 0);
        return loaded.length >= expected;
      },
      { timeout: 60_000, polling: 500 },
      expectedThumbnails,
    );
  } catch {
    const loaded = await page.evaluate(
      () =>
        [...document.querySelectorAll("img")].filter((img) => img.complete && img.naturalWidth > 0)
          .length,
    );
    throw new Error(
      `Gallery thumbnails did not finish loading: ${loaded}/${expectedThumbnails} images loaded.`,
    );
  }

  await sleep(800);
  const path = join(outputDir, "gallery.png");
  await page.screenshot({ path, type: "png" });
  console.log(`Saved ${path}`);
}

async function captureViewer(page) {
  // Desktop gallery cards open the viewer on double-click (BrowserEntryCard).
  // sample-09 is a vivid tile; the earliest samples are near-black and make a
  // dull viewer shot.
  await page.waitForSelector('button[title*="sample"], main button.absolute', {
    timeout: 15_000,
  });
  const tile =
    (await page.$('[title*="sample-09"]')) ??
    (await page.$('button[title*="sample"], main button.absolute'));
  if (!tile) {
    throw new Error("No gallery tile found to open the viewer.");
  }
  await tile.click({ clickCount: 2 });

  await page.waitForSelector('dialog[open][aria-label^="Viewer for"]', { timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector('dialog[open][aria-label^="Viewer for"]');
      if (!dialog) {
        return false;
      }
      const img = dialog.querySelector("img");
      return Boolean(img?.complete && img.naturalWidth > 0);
    },
    { timeout: 30_000, polling: 250 },
  );

  await sleep(800);
  const path = join(outputDir, "viewer.png");
  await page.screenshot({ path, type: "png" });
  console.log(`Saved ${path}`);
  await page.keyboard.press("Escape");
}

async function main() {
  await checkHealth();
  mkdirSync(outputDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=medium"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await primeDarkTheme(page);

    await captureLogin(page);
    await login(page);
    await captureGallery(page);
    await captureViewer(page);
  } finally {
    await browser.close();
  }

  console.log("Pane View screenshot capture complete.");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
