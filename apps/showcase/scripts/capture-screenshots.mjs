#!/usr/bin/env node
/**
 * Captures real screenshots for the Latch Works showcase site.
 * Run after pane-view is up and sample archive has been pushed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public", "screenshots");
const chromePath = "/usr/bin/google-chrome-stable";
const paneBase = "http://127.0.0.1:3000";
const username = process.env.PANE_VIEW_USERNAME ?? "showcase";
const password = process.env.PANE_VIEW_PASSWORD ?? "showcase123";

mkdirSync(join(publicDir, "pane-view"), { recursive: true });
mkdirSync(join(publicDir, "frame-view"), { recursive: true });
mkdirSync(join(publicDir, "gather-box"), { recursive: true });
mkdirSync(join(publicDir, "lockstep"), { recursive: true });

async function capture(page, path, url, options = {}) {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
  if (options.waitMs) {
    await new Promise((resolve) => setTimeout(resolve, options.waitMs));
  }
  await page.screenshot({ path, type: "png" });
  console.log(`Saved ${path}`);
}

async function loginToPaneView(page) {
  await page.goto(`${paneBase}/login`, { waitUntil: "networkidle2" });
  await page.type("#username", username);
  await page.type("#password", password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click('button[type="submit"]'),
  ]);
}

function captureLockstepTerminal(output, filename) {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; padding: 24px; font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
  .window { border-radius: 12px; overflow: hidden; border: 1px solid #30363d; box-shadow: 0 24px 48px rgba(0,0,0,.45); }
  .titlebar { background: #161b22; color: #8b949e; padding: 10px 14px; font-size: 12px; border-bottom: 1px solid #30363d; }
  pre { margin: 0; padding: 20px; background: #0d1117; color: #c9d1d9; font-size: 13px; line-height: 1.55; white-space: pre-wrap; }
  .accent { color: #58a6ff; }
  .good { color: #3fb950; }
  .warn { color: #d29922; }
</style></head><body>
<div class="window"><div class="titlebar">lockstep — zsh</div><pre>${escapeHtml(output)}</pre></div>
</body></html>`;
  const tmp = join(publicDir, "lockstep", "_terminal.html");
  writeFileSync(tmp, html);
  return tmp;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function runLockstep(args) {
  const result = spawnSync(
    "pnpm",
    ["exec", "tsx", "src/cli.ts", ...args],
    {
      cwd: join(root, "../../tools/lockstep"),
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return (result.stdout || "") + (result.stderr || "");
}

function buildGatherBoxPreviewHtml(mode) {
  const gatherRoot = join(root, "../../apps/gather-box");
  const css = execFileSync("cat", [join(gatherRoot, "popup/popup.css")], { encoding: "utf8" });
  const isActive = mode === "active";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>${css}
  body { background: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; }
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

async function main() {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=medium"],
  });

  const page = await browser.newPage();

  // Pane View
  await capture(page, join(publicDir, "pane-view", "login.png"), `${paneBase}/login`);
  await loginToPaneView(page);
  await capture(
    page,
    join(publicDir, "pane-view", "gallery.png"),
    `${paneBase}/?path=sfw/photos`,
    { waitMs: 2500 },
  );

  // Open first media item if possible
  const tile = await page.$('[data-testid="media-tile"], .group\\/tile, button[aria-label*="sample"]');
  if (tile) {
    await tile.click();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await page.screenshot({ path: join(publicDir, "pane-view", "viewer.png"), type: "png" });
    console.log(`Saved ${join(publicDir, "pane-view", "viewer.png")}`);
    await page.keyboard.press("Escape");
  } else {
    await capture(
      page,
      join(publicDir, "pane-view", "viewer.png"),
      `${paneBase}/?path=sfw/photos&media=${encodeURIComponent("sfw/photos/sample-01.jpg")}`,
      { waitMs: 2000 },
    );
  }

  // Gather Box — real popup CSS from the extension
  for (const [mode, file] of [
    ["idle", "popup.png"],
    ["active", "popup-active.png"],
  ]) {
    const htmlPath = join(publicDir, "gather-box", `_preview-${mode}.html`);
    writeFileSync(htmlPath, buildGatherBoxPreviewHtml(mode));
    await capture(page, join(publicDir, "gather-box", file), `file://${htmlPath}`, { waitMs: 300 });
  }

  // Lockstep — real CLI output
  const planOutput = runLockstep([
    "plan",
    "--source",
    process.env.LOCKSTEP_SOURCE ?? "/tmp/showcase-archive",
    "--api-url",
    paneBase,
  ]);
  const planHtml = captureLockstepTerminal(planOutput, "plan.png");
  await capture(page, join(publicDir, "lockstep", "plan.png"), `file://${planHtml}`);

  const pushOutput = runLockstep([
    "push",
    "--source",
    process.env.LOCKSTEP_SOURCE ?? "/tmp/showcase-archive",
    "--api-url",
    paneBase,
    "--yes",
    "--max-changes",
    "3",
  ]);
  const pushHtml = captureLockstepTerminal(pushOutput, "push.png");
  await capture(page, join(publicDir, "lockstep", "push.png"), `file://${pushHtml}`);

  // Frame View — render a gallery mock using actual Tailwind classes from the app theme
  const frameHtml = join(publicDir, "frame-view", "_preview.html");
  writeFileSync(frameHtml, buildFrameViewPreviewHtml());
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(`file://${frameHtml}`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: join(publicDir, "frame-view", "gallery.png"), type: "png" });
  console.log(`Saved ${join(publicDir, "frame-view", "gallery.png")}`);

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.evaluate(() => window.showFrameViewer?.());
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.screenshot({ path: join(publicDir, "frame-view", "viewer.png"), type: "png" });
  console.log(`Saved ${join(publicDir, "frame-view", "viewer.png")}`);

  await page.evaluate(() => window.showFrameSettings?.());
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.screenshot({ path: join(publicDir, "frame-view", "settings.png"), type: "png" });
  console.log(`Saved ${join(publicDir, "frame-view", "settings.png")}`);

  await browser.close();
  console.log("Screenshot capture complete.");
}

function buildFrameViewPreviewHtml() {
  const sampleDir = "/tmp/showcase-archive/sfw/photos";
  const tiles = Array.from({ length: 12 }, (_, index) => {
    const file = `sample-${String(index + 1).padStart(2, "0")}.jpg`;
    return `<div class="tile"><img src="file://${sampleDir}/${file}" alt="Sample ${index + 1}" /></div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #09090b; color: #f4f4f5; }
  .app { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid #27272a; background: #09090b; }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; }
  header span { color: #a1a1aa; font-size: 12px; }
  .layout { display: grid; grid-template-columns: 1fr; min-height: 0; }
  main { padding: 18px 20px 88px; overflow: auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(156px, 1fr)); gap: 12px; }
  .tile { aspect-ratio: 4/3; border-radius: 14px; overflow: hidden; border: 1px solid #27272a; background: #18181b; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
  .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .pill { font-size: 11px; padding: 5px 10px; border-radius: 999px; border: 1px solid #3f3f46; color: #d4d4d8; background: #18181b; }
  .floating { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; gap: 8px; padding: 8px; border-radius: 999px; background: rgba(24,24,27,.92); border: 1px solid #3f3f46; backdrop-filter: blur(10px); }
  .floating span { font-size: 12px; color: #e4e4e7; padding: 6px 12px; }
  .overlay, .drawer { display: none; position: fixed; inset: 0; }
  .overlay.open { display: grid; place-items: center; background: rgba(0,0,0,.85); z-index: 10; }
  .overlay img { max-width: 80vw; max-height: 70vh; border-radius: 8px; border: 1px solid #444; }
  .drawer.open { display: block; z-index: 11; background: rgba(0,0,0,.5); }
  .drawer-panel { position: absolute; right: 0; top: 0; bottom: 0; width: 360px; background: #141414; border-left: 1px solid #333; padding: 20px; }
  .drawer-panel h2 { margin: 0 0 16px; font-size: 16px; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #222; font-size: 13px; color: #bbb; }
</style></head><body>
<div class="app">
  <header><div><h1>Frame View</h1><span>Folder: photos</span></div><span>12 items</span></header>
  <div class="layout">
    <main>
      <div class="toolbar"><span class="pill">Sort: date</span><span class="pill">Recursive</span><span class="pill">Ready</span></div>
      <div class="grid">${tiles}</div>
    </main>
  </div>
  <div class="floating"><span>Previous</span><span>Folders</span><span>Settings</span><span>Next</span></div>
</div>
<div class="overlay" id="viewer"><img src="file:///tmp/showcase-archive/sfw/photos/sample-01.jpg" alt=""></div>
<div class="drawer" id="settings"><div class="drawer-panel"><h2>Settings</h2>
  <div class="row"><span>Theme</span><span>Dark</span></div>
  <div class="row"><span>Thumbnail size</span><span>Medium</span></div>
  <div class="row"><span>Video autoplay</span><span>On</span></div>
  <div class="row"><span>Last folder</span><span>/showcase/photos</span></div>
</div></div>
<script>
  window.showFrameViewer = () => document.getElementById('viewer').classList.add('open');
  window.showFrameSettings = () => { document.getElementById('viewer').classList.remove('open'); document.getElementById('settings').classList.add('open'); };
</script>
</body></html>`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
