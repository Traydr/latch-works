#!/usr/bin/env node
/**
 * Captures real screenshots for the Latch Works showcase site.
 * Run after pane-view is up when capturing Pane View / Lockstep output.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { writePaneViewFallbackPages } from "./pane-view-fallback.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "../..");
const publicDir = join(root, "public", "screenshots");
const framePreviewBase = process.env.FRAME_VIEW_SHOWCASE_URL ?? "http://127.0.0.1:5199";
const lockstepPreviewBase = process.env.LOCKSTEP_SHOWCASE_URL ?? "http://127.0.0.1:5200";

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

const username = process.env.PANE_VIEW_USERNAME ?? "showcase";
const password = process.env.PANE_VIEW_PASSWORD ?? "showcase123";

async function probePaneHealth(base) {
  try {
    const response = await fetch(`${base}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function resolvePaneBase() {
  if (process.env.PANE_VIEW_URL) {
    return process.env.PANE_VIEW_URL.replace(/\/$/, "");
  }

  for (const base of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
    if (await probePaneHealth(base)) {
      return base;
    }
  }

  return "http://localhost:3000";
}

function resolveBundledChrome() {
  const cacheRoot = join(root, "chrome");
  if (!existsSync(cacheRoot)) {
    return null;
  }

  for (const platformDir of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!platformDir.isDirectory()) {
      continue;
    }

    const bundleRoot = join(cacheRoot, platformDir.name);
    const candidates = [
      join(
        bundleRoot,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
      join(
        bundleRoot,
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
      join(bundleRoot, "chrome-linux64/chrome"),
      join(bundleRoot, "chrome-win64/chrome.exe"),
    ];

    const match = candidates.find((candidate) => existsSync(candidate));
    if (match) {
      return match;
    }
  }

  return null;
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  resolveBundledChrome(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));

if (!chromePath) {
  console.error(
    "Chrome/Chromium not found. Set CHROME_PATH or run: pnpm exec browsers install chrome@stable",
  );
  process.exit(1);
}

mkdirSync(join(publicDir, "pane-view"), { recursive: true });
mkdirSync(join(publicDir, "frame-view"), { recursive: true });
mkdirSync(join(publicDir, "gather-box"), { recursive: true });
mkdirSync(join(publicDir, "lockstep"), { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(page, path, url, options = {}) {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  if (options.darkMode) {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  }
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
  if (options.prepare) {
    await options.prepare(page);
  }
  if (options.waitMs) {
    await sleep(options.waitMs);
  }
  await page.screenshot({ path, type: "png" });
  console.log(`Saved ${path}`);
}

async function applyPaneViewDarkMode(page) {
  await page.evaluate(() => {
    const defaults = {
      theme: "dark",
      rememberLastFolder: true,
      recursiveDefault: false,
      sortMode: "name-asc",
      showDetailPanel: true,
    };
    window.localStorage.setItem("pane-view.settings", JSON.stringify(defaults));
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  });
}

async function loginToPaneView(page, paneBase) {
  await applyPaneViewDarkMode(page);
  await page.goto(`${paneBase}/login`, { waitUntil: "networkidle2" });
  await applyPaneViewDarkMode(page);
  await page.type("#username", username);
  await page.type("#password", password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click('button[type="submit"]'),
  ]);
  await applyPaneViewDarkMode(page);
}

function buildGatherBoxPreviewHtml(mode) {
  const gatherRoot = join(root, "../../apps/gather-box");
  const css = execFileSync("cat", [join(gatherRoot, "popup/popup.css")], { encoding: "utf8" });
  const isActive = mode === "active";
  return `<!DOCTYPE html>
<html lang="en" class="dark"><head><meta charset="utf-8"><style>${css}
  body { background: #09090b; display: grid; place-items: center; min-height: 100vh; margin: 0; color-scheme: dark; }
  .popup { width: 360px; }
</style></head><body>
<main class="popup">
  <header class="header">
    <h1>Gather Box</h1>
    <span class="badge" style="${isActive ? "background:#1f3d2c;color:#6ec98e" : ""}">${isActive ? "READY" : "IDLE"}</span>
  </header>
  <button class="btn btn-primary btn-huge btn-full" type="button" ${isActive ? "" : "disabled"}>Download Content</button>
  <div class="folder-row">
    <span class="label">Folder</span>
    <span class="value truncate">${isActive ? "media/sfw/patreon/artist" : "No folder selected"}</span>
    <button class="btn btn-ghost btn-tiny" type="button">Choose</button>
  </div>
  <p class="sub">${isActive ? "Folder ready for this download run." : "Choose a writable folder for this run."}</p>
  <progress class="progress" max="1" value="${isActive ? "0.35" : "0"}"></progress>
  <p class="sub center">${isActive ? "Downloading page 7 of 20…" : "Waiting for a supported page and folder."}</p>
  <div class="status-row">
    <span class="label">Page</span>
    <span class="value">${isActive ? "Supported gallery" : "Unsupported"}</span>
  </div>
  <p class="sub">${isActive ? "Fanbox post detected — 20 images found." : "The active tab is checked when the popup opens."}</p>
</main>
</body></html>`;
}

async function waitForFramePreview(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('[data-gallery-item="true"]').length >= 8,
    { timeout: 30_000 },
  );
}

async function startLockstepPreview() {
  const child = spawn("pnpm", ["--filter", "@latch-works/lockstep-app", "preview:showcase"], {
    cwd: join(root, "../.."),
    stdio: "ignore",
    detached: true,
    env: { ...process.env },
  });
  child.unref();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${lockstepPreviewBase}/showcase-preview.html?screen=plan`);
      if (response.ok) {
        return child;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }

  child.kill();
  throw new Error("Lockstep showcase preview did not start on port 5200");
}

async function startFrameViewPreview() {
  const child = spawn("pnpm", ["--filter", "@latch-works/frame-view", "preview:showcase"], {
    cwd: join(root, "../.."),
    stdio: "ignore",
    detached: true,
    env: { ...process.env },
  });
  child.unref();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${framePreviewBase}/showcase-preview.html`);
      if (response.ok) {
        return child;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }

  child.kill();
  throw new Error("Frame View showcase preview did not start on port 5199");
}

async function main() {
  const paneBase = await resolvePaneBase();

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=medium"],
  });

  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);

  let framePreviewProcess = null;
  let lockstepPreviewProcess = null;

  try {
    const paneHealthy = await probePaneHealth(paneBase);

    if (paneHealthy) {
      await capture(page, join(publicDir, "pane-view", "login.png"), `${paneBase}/login`, {
        darkMode: true,
        prepare: applyPaneViewDarkMode,
      });
      await loginToPaneView(page, paneBase);
      await capture(
        page,
        join(publicDir, "pane-view", "gallery.png"),
        `${paneBase}/?path=sfw/photos`,
        { darkMode: true, waitMs: 3000, prepare: applyPaneViewDarkMode },
      );

      const tile = await page.$(
        '[data-testid="media-tile"], [data-gallery-item="true"], button[aria-label*="sample"]',
      );
      if (tile) {
        await tile.click();
        await sleep(1800);
        await page.screenshot({ path: join(publicDir, "pane-view", "viewer.png"), type: "png" });
        console.log(`Saved ${join(publicDir, "pane-view", "viewer.png")}`);
        await page.keyboard.press("Escape");
      } else {
        await capture(
          page,
          join(publicDir, "pane-view", "viewer.png"),
          `${paneBase}/?path=sfw/photos&media=${encodeURIComponent("sfw/photos/sample-01.jpg")}`,
          { darkMode: true, waitMs: 2500, prepare: applyPaneViewDarkMode },
        );
      }
    } else {
      console.warn(
        "Pane View is not running — capturing dark-mode fallback pane-view screenshots.",
      );
      const fallbackPages = writePaneViewFallbackPages(publicDir);
      for (const [name, fileName] of [
        ["login", "login.png"],
        ["gallery", "gallery.png"],
        ["viewer", "viewer.png"],
      ]) {
        const pageInfo = fallbackPages[name];
        writeFileSync(pageInfo.htmlPath, pageInfo.html);
        await capture(page, join(publicDir, "pane-view", fileName), `file://${pageInfo.htmlPath}`, {
          darkMode: true,
          waitMs: 400,
        });
      }
    }

    for (const [mode, file] of [
      ["idle", "popup.png"],
      ["active", "popup-active.png"],
    ]) {
      const htmlPath = join(publicDir, "gather-box", `_preview-${mode}.html`);
      writeFileSync(htmlPath, buildGatherBoxPreviewHtml(mode));
      await capture(page, join(publicDir, "gather-box", file), `file://${htmlPath}`, {
        darkMode: true,
        waitMs: 300,
      });
    }

    lockstepPreviewProcess = await startLockstepPreview();
    await capture(
      page,
      join(publicDir, "lockstep", "plan.png"),
      `${lockstepPreviewBase}/showcase-preview.html?screen=plan`,
      { darkMode: true, waitMs: 800 },
    );
    await capture(
      page,
      join(publicDir, "lockstep", "push.png"),
      `${lockstepPreviewBase}/showcase-preview.html?screen=push`,
      { darkMode: true, waitMs: 800 },
    );

    framePreviewProcess = await startFrameViewPreview();
    await capture(
      page,
      join(publicDir, "frame-view", "gallery.png"),
      `${framePreviewBase}/showcase-preview.html`,
      {
        darkMode: true,
        waitMs: 1200,
        prepare: waitForFramePreview,
      },
    );

    const firstTile = await page.$('[data-gallery-item="true"]');
    if (firstTile) {
      await firstTile.click({ clickCount: 2 });
      await sleep(900);
      await page.screenshot({ path: join(publicDir, "frame-view", "viewer.png"), type: "png" });
      console.log(`Saved ${join(publicDir, "frame-view", "viewer.png")}`);
      await page.keyboard.press("Escape");
      await sleep(400);
    }

    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((element) =>
        element.textContent?.trim().includes("Settings"),
      );
      button?.click();
    });
    await sleep(700);
    await page.screenshot({ path: join(publicDir, "frame-view", "settings.png"), type: "png" });
    console.log(`Saved ${join(publicDir, "frame-view", "settings.png")}`);
  } finally {
    if (lockstepPreviewProcess) {
      lockstepPreviewProcess.kill();
    }
    if (framePreviewProcess) {
      framePreviewProcess.kill();
    }
    await browser.close();
  }

  console.log("Screenshot capture complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
