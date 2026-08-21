#!/usr/bin/env node
/**
 * Captures real Lockstep screenshots for the showcase site.
 *
 * Seeds fresh sample scans into the showcase archive, launches the actual
 * Electron app with remote debugging enabled, drives a real plan + push against
 * the local Pane View sync API, and captures plan/push at 1440x900 @2x (dark).
 *
 * Requirements before running:
 * - Pane View dev server on http://localhost:3000 (`pnpm --filter @latch-works/pane-view dev`).
 * - PANE_VIEW_SYNC_TOKEN set in the repo root .env.
 * - Showcase archive at /tmp/showcase-archive (see prepare-showcase-media.mjs).
 *
 * The user's Lockstep settings file is moved aside before launch and restored
 * byte-identical after the app quits (the app rewrites the file on exit). The
 * legacy ~/.latch-works/lockstep.json is pointed at the showcase archive so the
 * app migrates it into a ready profile; its original content is restored too.
 *
 * Usage: node apps/showcase/scripts/capture-lockstep.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "../..");
const outputDir = join(root, "public", "screenshots", "lockstep");
const archiveDir = process.env.LOCKSTEP_SOURCE ?? "/tmp/showcase-archive";
const scansDir = join(archiveDir, "sfw/scans");
const apiUrl = "http://localhost:3000";
const settingsPath = join(homedir(), "Library/Application Support/Lockstep/lockstep-settings.json");
const settingsBackupPath = `${settingsPath}.showcase-backup`;
const legacyConfigPath = join(homedir(), ".latch-works/lockstep.json");
const debugPort = Number(process.env.LOCKSTEP_DEBUG_PORT ?? 9224);
const debugBase = `http://127.0.0.1:${debugPort}`;

const require = createRequire(join(repoRoot, "apps/frame-view/package.json"));
const sharp = require("sharp");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readSyncToken() {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`Repo root .env not found at ${envPath}`);
  }
  const match = readFileSync(envPath, "utf8").match(/^PANE_VIEW_SYNC_TOKEN=(.+)$/m);
  const token = match?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!token) {
    throw new Error("PANE_VIEW_SYNC_TOKEN is not set in the repo root .env");
  }
  return token;
}

async function assertServerIsUp() {
  try {
    await fetch(apiUrl);
  } catch {
    throw new Error(`Pane View server is not reachable at ${apiUrl}. Start the dev server first.`);
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
 * Writes six distinct sample scans. Regenerated on every run (random mosaic
 * tiles) so a rerun after a successful push still plans real uploads/updates.
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
    const frame =
      `<rect x="120" y="120" width="2160" height="1560" rx="64" ` +
      `fill="${accents[index]}" opacity="0.18"/>`;
    const caption =
      `<text x="1200" y="930" text-anchor="middle" fill="#f4f4f5" ` +
      `font-family="Segoe UI, system-ui, sans-serif" font-size="180" ` +
      `font-weight="600">Scan ${label}</text>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1800">
      ${tiles.join("\n")}
      ${frame}
      ${caption}
    </svg>`;
    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
    writeFileSync(join(scansDir, `scan-${label}.jpg`), jpeg);
  }
  console.log(`Seeded 6 scan images in ${scansDir}`);
}

/** Points the legacy config at the showcase archive; returns the original bytes (or null). */
function writeLegacyConfig() {
  const original = existsSync(legacyConfigPath) ? readFileSync(legacyConfigPath) : null;
  const desired = {
    apiUrl,
    defaults: { hashFiles: false, showSkipped: false },
    source: archiveDir,
  };
  mkdirSync(dirname(legacyConfigPath), { recursive: true });
  writeFileSync(legacyConfigPath, `${JSON.stringify(desired, null, 2)}\n`);
  return original;
}

function startLockstep() {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@latch-works/lockstep-app",
      "start",
      "--",
      `--remote-debugging-port=${debugPort}`,
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
      throw new Error(`Lockstep exited before debug port came up:\n${app.getOutput()}`);
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
  throw new Error("No Lockstep app page found among debugger targets");
}

/**
 * Clicks a CommandDock pipeline stage. Stage buttons render as "<n>Label" or
 * "✓Label", which distinguishes them from the plain "Plan" workspace tab.
 */
async function clickStage(page, label) {
  const clicked = await page.evaluate((stageLabel) => {
    const pattern = new RegExp(`^(?:\\d|✓)${stageLabel}$`);
    const button = [...document.querySelectorAll("button")].find(
      (element) => pattern.test(element.textContent?.trim() ?? "") && !element.disabled,
    );
    button?.click();
    return Boolean(button);
  }, label);
  if (!clicked) {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800));
    throw new Error(`Enabled "${label}" stage button not found. Visible text:\n${bodyText}`);
  }
}

async function isRunning(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("button")].some((el) => el.textContent?.trim() === "Cancel"),
  );
}

async function waitForRunToFinish(page, action, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isRunning(page))) {
      return;
    }
    await sleep(300);
  }
  throw new Error(`${action} run did not finish within ${timeoutMs / 1000}s`);
}

function readPlanCounts(bodyText) {
  // The plan legend renders as "upload 6 · update 0 · delete 0 · keep 18".
  const count = (word) => {
    const match = bodyText.match(new RegExp(`${word}\\s+(\\d+)`));
    return match ? Number(match[1]) : 0;
  };
  return {
    upload: count("upload"),
    update: count("update"),
    delete: count("delete"),
    keep: count("keep"),
  };
}

async function saveScreenshot(page, name) {
  const path = join(outputDir, name);
  await page.screenshot({ path, type: "png" });
  const png = readFileSync(path);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  console.log(`Saved ${path} (${width}x${height})`);
  if (width !== 2880 || height !== 1800) {
    console.warn(`Warning: expected 2880x1800; viewport emulation may have misbehaved.`);
  }
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
  console.warn("Lockstep did not shut down cleanly; sending SIGKILL.");
  try {
    process.kill(-app.child.pid, "SIGKILL");
  } catch {
    // Process group already gone.
  }
  await sleep(2000);
}

async function main() {
  const token = readSyncToken();
  await assertServerIsUp();
  if (!existsSync(archiveDir)) {
    throw new Error(`Showcase archive missing at ${archiveDir}; run prepare-showcase-media.mjs`);
  }
  if (await debugPortIsUp()) {
    throw new Error(`Port ${debugPort} already serving CDP. Quit the running Lockstep first.`);
  }

  mkdirSync(outputDir, { recursive: true });
  await seedScanImages();

  const settingsExisted = existsSync(settingsPath);
  const settingsHashBefore = settingsExisted ? sha256OfFile(settingsPath) : null;
  if (settingsExisted) {
    renameSync(settingsPath, settingsBackupPath);
    console.log(`Moved user settings aside to ${settingsBackupPath}`);
  }
  const legacyOriginal = writeLegacyConfig();

  let app = null;
  let browser = null;
  try {
    app = startLockstep();
    console.log("Waiting for Lockstep to boot (prestart can take a while)...");
    await waitForDebugPort(app);

    const connection = await connectToAppPage();
    browser = connection.browser;
    const page = connection.page;

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.bringToFront();

    // The migrated legacy profile has no stored token; enter it for the session.
    const tokenSelector = 'input[placeholder="Enter token for this session"]';
    await page.waitForSelector(tokenSelector, { timeout: 60_000 }).catch(async () => {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800));
      throw new Error(`Token input never appeared; legacy migration failed?\n${bodyText}`);
    });
    await page.type(tokenSelector, token);

    // Plan: runs a real scan + remote snapshot diff, then auto-opens the review tab.
    await clickStage(page, "Plan");
    await sleep(500);
    await waitForRunToFinish(page, "Plan");
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll("h2")].some(
            (el) => el.textContent?.trim() === "Review changes",
          ),
        { timeout: 30_000 },
      )
      .catch(async () => {
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
        throw new Error(`Plan review view never appeared. Visible text:\n${bodyText}`);
      });
    await sleep(800);

    const bodyText = await page.evaluate(() => document.body.innerText);
    const counts = readPlanCounts(bodyText);
    console.log(`Plan counts: ${JSON.stringify(counts)}`);
    if (counts.upload + counts.update === 0) {
      throw new Error("Plan shows no pending uploads/updates; the screenshot would be boring.");
    }
    await saveScreenshot(page, "plan.png");

    // Push: really uploads to the local server. Local pushes of the six small
    // scans finish faster than a 2880x1800 screenshot cycle, so a mid-run frame
    // is a lottery; capture the completed run on the Log tab instead — the run
    // log plus the PUSHED stat is the informative, reproducible frame.
    await clickStage(page, "Push");
    const sawRunning = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll("button")].some(
            (el) => el.textContent?.trim() === "Cancel",
          ),
        { timeout: 120_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!sawRunning) {
      throw new Error("Push never appeared to start (no Cancel button observed within 120s).");
    }
    await waitForRunToFinish(page, "Push");

    const openedLog = await page.evaluate(() => {
      const tab = [...document.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === "Log",
      );
      tab?.click();
      return Boolean(tab);
    });
    if (!openedLog) {
      console.warn("Log tab not found; capturing the review view instead.");
    }
    await sleep(800);
    await saveScreenshot(page, "push.png");
    const pushedStat = await page.evaluate(
      () => document.body.innerText.match(/pushed\s*\n?\s*\d+/i)?.[0],
    );
    console.log(`Push stat: ${pushedStat ?? "not found"}`);
  } finally {
    if (browser) {
      await browser.disconnect().catch(() => {});
    }
    if (app) {
      await shutDownApp(app);
    }
    if (legacyOriginal === null) {
      rmSync(legacyConfigPath, { force: true });
    } else {
      writeFileSync(legacyConfigPath, legacyOriginal);
    }
    console.log("Restored legacy config.");
    if (settingsExisted) {
      rmSync(settingsPath, { force: true });
      renameSync(settingsBackupPath, settingsPath);
      const settingsHashAfter = sha256OfFile(settingsPath);
      if (settingsHashAfter === settingsHashBefore) {
        console.log("Restored user settings byte-identical.");
      } else {
        console.warn("Warning: restored settings hash differs from the original!");
      }
    } else if (existsSync(settingsPath)) {
      rmSync(settingsPath, { force: true });
      console.log("Removed settings file created during capture (none existed before).");
    }
  }

  console.log("Lockstep capture complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
