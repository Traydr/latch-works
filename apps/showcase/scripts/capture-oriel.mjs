#!/usr/bin/env node
/**
 * Captures real Oriel screenshots for the showcase site, into public/screenshots/oriel/: View's
 * gallery, viewer and settings (view-*.png), Tidy's overview (tidy-overview.png), and Sync's plan
 * and push (sync-*.png), in the dark theme, from a 1440x900 window on a Retina display
 * (2880x1800 PNGs).
 *
 * Launches the bundled app (apps/oriel/target/release/bundle/Oriel.app, or the binary ORIEL_BIN
 * names) once per screenshot, on a throwaway data folder: the run is sandboxed, so your own
 * folders, catalogs, profiles and tokens are never touched. The `ORIEL_*` check variables
 * (docs/runbooks/oriel.md) open each screen, and `screencapture` takes the window once two
 * captures in a row match, so thumbnails and scans have settled.
 *
 * Requirements before running (macOS only):
 * - The bundle: pnpm --filter @latch-works/oriel bundle.
 * - The Xcode command line tools, for `swiftc`, which builds the window-ID lookup.
 * - Screen Recording permission for the terminal that runs this.
 * - The showcase archive at /tmp/showcase-archive (node scripts/prepare-showcase-media.mjs).
 * - For Sync, a Pane View server: http://localhost:3000 with PANE_VIEW_SYNC_TOKEN in the repo
 *   root .env, or SHOWCASE_PANE_VIEW_URL and SHOWCASE_SYNC_TOKEN naming another one. The push
 *   uploads the archive's photos and freshly seeded scans to that server.
 *
 * Usage: node apps/showcase/scripts/capture-oriel.mjs [view] [tidy] [sync]   (all three by default)
 */
import { execFileSync, spawn } from "node:child_process";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertShowcaseArchive, showcaseArchiveDir } from "./showcase-archive.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const repoRoot = join(root, "../..");

const screenshotsDir = join(root, "public", "screenshots", "oriel");

const photosDir = join(showcaseArchiveDir, "sfw/photos");

const scansDir = join(showcaseArchiveDir, "sfw/scans");

const apiUrl = process.env.SHOWCASE_PANE_VIEW_URL ?? "http://localhost:3000";

const orielBinary =
  process.env.ORIEL_BIN ??
  join(repoRoot, "apps/oriel/target/release/bundle/Oriel.app/Contents/MacOS/oriel");

// sharp is the repository root's dev dependency, not the showcase's.
const sharp = createRequire(join(repoRoot, "package.json"))("sharp");

const windowSize = { width: 1440, height: 900 };

const sections = new Set(
  process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["view", "tidy", "sync"],
);

/** The largest ordinary window a process has on screen, as its CGWindowID. */
const windowIdSource = `
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
func area(_ w: [String: Any]) -> CGFloat {
  let r = w[kCGWindowBounds as String] as! [String: CGFloat]
  return r["Width"]! * r["Height"]!
}
guard let best = mine.max(by: { area($0) < area($1) }) else { exit(1) }
print(best[kCGWindowNumber as String] as! Int)
`;

/** `ORIEL_SCRIPT` steps, in window points: the pointer at rest on the sidebar's empty space. */
const parkPointer = "wait 1000;move 170,640";

/** A minute of small pointer moves near the top of the window, every half second. */
const keepViewerControls = [
  "wait 1500",
  ...Array.from({ length: 120 }, (_, index) => `move ${720 + (index % 2)},120;wait 500`),
].join(";");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWindowIdTool(workDir) {
  const source = join(workDir, "window-id.swift");
  const binary = join(workDir, "window-id");
  writeFileSync(source, windowIdSource);
  execFileSync("swiftc", ["-O", source, "-o", binary], { stdio: "inherit" });

  return binary;
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
      <text x="1200" y="930" text-anchor="middle" fill="#f4f4f5" font-family="system-ui, sans-serif" font-size="180" font-weight="600">Scan ${label}</text>
    </svg>`;

    writeFileSync(
      join(scansDir, `scan-${label}.jpg`),
      await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer(),
    );
  }

  console.log(`Seeded 6 scan images in ${scansDir}`);
}

/** The shell's remembered state: the window's size, the dark theme, and the mode to open in. */
function rememberShell(dataDir, mode) {
  const shellDir = join(dataDir, "shell");
  mkdirSync(shellDir, { recursive: true });
  writeFileSync(
    join(shellDir, "window-state.json"),
    `${JSON.stringify({ bounds: { x: 40, y: 40, ...windowSize }, maximized: false })}\n`,
  );
  writeFileSync(
    join(shellDir, "local-storage.json"),
    `${JSON.stringify({ "oriel.mode": mode, "oriel.theme": "dark" })}\n`,
  );
  // Skip the first-run welcome.
  writeFileSync(join(shellDir, "welcomed"), "");
}

/**
 * One Sync profile for the showcase archive, its token sealed as Oriel's FileSecretStorage seals
 * it: AES-256-GCM under the key in sync/secret-storage.key, stored as iv | tag | ciphertext.
 */
function seedSyncProfile(dataDir, token) {
  const syncDir = join(dataDir, "sync");
  mkdirSync(syncDir, { mode: 0o700, recursive: true });
  const key = randomBytes(32);
  writeFileSync(join(syncDir, "secret-storage.key"), key, { mode: 0o600 });

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);

  const profileId = randomUUID();
  writeFileSync(
    join(syncDir, "lockstep-settings.json"),
    `${JSON.stringify(
      {
        activeProfileId: profileId,
        profiles: [
          {
            apiUrl,
            encryptedToken: sealed.toString("base64"),
            id: profileId,
            name: "Showcase",
            sourceRoot: showcaseArchiveDir,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

/** Tidy takes only roots in a sandboxed run's sandbox/: it scans a copy of the archive there. */
function copyArchiveIntoSandbox(dataDir) {
  const copy = join(dataDir, "sandbox", "showcase-archive");
  mkdirSync(join(dataDir, "sandbox"), { recursive: true });
  execFileSync("cp", ["-c", "-R", showcaseArchiveDir, copy]);

  return copy;
}

/** The shell's environment without its `ORIEL_*` variables, so only this script's reach the app. */
function baseEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("ORIEL_")),
  );
}

function launch(dataDir, env) {
  const child = spawn(orielBinary, [], {
    cwd: dataDir,
    env: { ...baseEnvironment(), ...env, ORIEL_DATA_DIR: dataDir },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let output = "";

  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return { child, getOutput: () => output };
}

async function waitForWindow(app, windowIdTool, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (app.child.exitCode !== null) {
      throw new Error(`Oriel exited before its window opened:\n${app.getOutput()}`);
    }

    try {
      return execFileSync(windowIdTool, [String(app.child.pid)], { encoding: "utf8" }).trim();
    } catch {
      await sleep(500);
    }
  }

  throw new Error(`Oriel's window did not appear in time:\n${app.getOutput()}`);
}

function captureWindow(windowId, path) {
  // -o leaves out the window's shadow; -x is silent. The pointer is never in a window capture.
  execFileSync("screencapture", ["-x", "-o", `-l${windowId}`, path]);

  return readFileSync(path);
}

/**
 * Captures until two captures in a row match, so loading thumbnails, scans and runs have finished
 * drawing. Gives up on that after `timeoutMs` and keeps the last capture.
 */
async function captureSettled(windowId, path, { minWaitMs = 2000, timeoutMs = 120_000 } = {}) {
  await sleep(minWaitMs);
  const deadline = Date.now() + timeoutMs;
  let previous = captureWindow(windowId, path);

  while (Date.now() < deadline) {
    await sleep(1500);
    const next = captureWindow(windowId, path);

    if (next.equals(previous)) {
      return;
    }

    previous = next;
  }

  console.warn(`${path} was still changing after ${timeoutMs / 1000}s; kept the last capture.`);
}

async function quit(app) {
  if (app.child.exitCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => app.child.once("exit", resolve));
  app.child.kill("SIGTERM");
  const timedOut = await Promise.race([exited.then(() => false), sleep(10_000).then(() => true)]);

  if (timedOut) {
    app.child.kill("SIGKILL");
    await exited;
  }
}

/** Launches Oriel on `dataDir` with `env`, saves its settled window as `name` in the oriel folder. */
async function shoot({ dataDir, env, name, windowIdTool, settle }) {
  mkdirSync(screenshotsDir, { recursive: true });
  const path = join(screenshotsDir, name);
  const app = launch(dataDir, env);

  try {
    const windowId = await waitForWindow(app, windowIdTool);
    await captureSettled(windowId, path, settle);
    console.log(`Saved ${path}`);
  } finally {
    await quit(app);
  }
}

async function captureView(workDir, windowIdTool) {
  const dataDir = join(workDir, "view");
  rememberShell(dataDir, "view");
  const base = { dataDir, windowIdTool };

  // The pointer rests on the sidebar's empty space, so no tile shows its hover details.
  await shoot({
    ...base,
    env: { ORIEL_OPEN: photosDir, ORIEL_SCRIPT: parkPointer },
    name: "view-gallery.png",
  });
  // sample-09 is a vivid tile; the earliest samples are near-black and make a dull viewer shot.
  // The pointer keeps moving near the top, so the viewer's auto-hiding controls stay in sight.
  await shoot({
    ...base,
    env: { ORIEL_OPEN: photosDir, ORIEL_SCRIPT: keepViewerControls, ORIEL_VIEW_VIEWER: "8" },
    name: "view-viewer.png",
  });
  await shoot({
    ...base,
    env: { ORIEL_SCRIPT: parkPointer, ORIEL_SETTINGS: "view" },
    name: "view-settings.png",
  });
}

async function captureTidy(workDir, windowIdTool) {
  const dataDir = join(workDir, "tidy");
  rememberShell(dataDir, "tidy");
  const archiveCopy = copyArchiveIntoSandbox(dataDir);

  await shoot({
    dataDir,
    env: { ORIEL_TIDY_PAGE: "overview", ORIEL_TIDY_ROOT: archiveCopy },
    name: "tidy-overview.png",
    // The scan, then background analysis and the conversion estimate.
    settle: { minWaitMs: 5000, timeoutMs: 240_000 },
    windowIdTool,
  });
}

async function captureSync(workDir, windowIdTool, token, pushClick) {
  const dataDir = join(workDir, "sync");
  rememberShell(dataDir, "sync");
  seedSyncProfile(dataDir, token);
  const base = { dataDir, windowIdTool };

  await shoot({ ...base, env: { ORIEL_SYNC_PLAN: "1" }, name: "sync-plan.png" });
  // The plan again, then Push, clicked through the window's own event path. A local push of a
  // few small files finishes before the first capture, so this shows the finished run.
  await shoot({
    ...base,
    env: { ORIEL_SCRIPT: `wait 4000;click ${pushClick}`, ORIEL_SYNC_PLAN: "1" },
    name: "sync-push.png",
    settle: { minWaitMs: 8000, timeoutMs: 120_000 },
  });
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("capture-oriel.mjs captures the window with macOS's screencapture.");
  }

  if (!existsSync(orielBinary)) {
    throw new Error(
      `No Oriel at ${orielBinary}. Run pnpm --filter @latch-works/oriel bundle, or set ORIEL_BIN.`,
    );
  }

  assertShowcaseArchive(showcaseArchiveDir);

  const token = sections.has("sync") ? readSyncToken() : null;

  if (sections.has("sync")) {
    await assertServerIsUp();
  }

  if (sections.has("tidy") || sections.has("sync")) {
    await seedScanImages();
  }

  const workDir = mkdtempSync(join(tmpdir(), "oriel-showcase-"));

  try {
    const windowIdTool = buildWindowIdTool(workDir);

    if (sections.has("view")) {
      await captureView(workDir, windowIdTool);
    }

    if (sections.has("tidy")) {
      await captureTidy(workDir, windowIdTool);
    }

    if (sections.has("sync") && token) {
      // Sync's Push button, the right-most in the top bar, in window points.
      await captureSync(workDir, windowIdTool, token, process.env.ORIEL_PUSH_AT ?? "1400,30");
    }
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }

  console.log("Oriel capture complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
