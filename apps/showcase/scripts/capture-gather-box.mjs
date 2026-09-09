#!/usr/bin/env node
/**
 * Captures real Gather Box side panel screenshots for the showcase site.
 *
 * Launches Chrome with the unpacked extension from apps/gather-box/dist and shoots:
 *   - sidepanel.png            — idle state (an open page the extension does not support)
 *   - sidepanel-active.png     — active state on a real supported page (an AO3 work)
 *   - sidepanel-in-browser.png — the active panel docked beside that work inside a 1440x900
 *                                browser frame, so the home plate gets a landscape like the
 *                                other products. The page and panel are real captures; the
 *                                tab strip, toolbar, and panel header are drawn, because
 *                                Chrome exposes neither its own chrome nor the side panel
 *                                container to CDP screenshots.
 *
 * Build the extension first: pnpm --filter @latch-works/gather-box build
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "../gather-box/dist");
const outputDir = join(root, "public", "screenshots", "gather-box");

const shots = [
  {
    outFile: "sidepanel.png",
    // The AO3 homepage sits on a permitted host but is not a collectable page, so the panel
    // renders its real "This isn't a supported page" idle state.
    contentUrl: "https://archiveofourown.org/",
    tabPattern: "https://archiveofourown.org/",
    readyInPanel: () => {
      const banner = document.getElementById("unsupportedBanner-mini");
      return banner !== null && !banner.hidden && (banner.textContent ?? "").length > 0;
    },
  },
  {
    outFile: "sidepanel-active.png",
    contentUrl: "https://archiveofourown.org/works/19182319",
    tabPattern: "https://archiveofourown.org/works/*",
    // Persist a real directory handle first so the panel's restore path runs and
    // the Download button renders enabled, as it would after a folder pick.
    seedFolderHandle: true,
    inBrowserOutFile: "sidepanel-in-browser.png",
    readyInPanel: () => {
      const banner = document.getElementById("unsupportedBanner-mini");
      const saveBlock = document.getElementById("saveBlock-mini");
      const savePath = document.getElementById("savePath-mini");
      return (
        banner?.hidden === true &&
        saveBlock?.hidden === false &&
        (savePath?.textContent ?? "").length > 0
      );
    },
  },
];

/**
 * Stores a real FileSystemDirectoryHandle (backed by the extension origin's
 * OPFS) under the keys the panel restores from — the same IndexedDB record a
 * user's folder pick writes. Runs inside a throwaway extension page.
 */
async function seedDirectoryHandle(browser, panelUrl) {
  const helper = await browser.newPage();
  await helper.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await helper.evaluate(async () => {
    const opfsRoot = await navigator.storage.getDirectory();
    const mediaHandle = await opfsRoot.getDirectoryHandle("media", { create: true });
    await new Promise((resolve, reject) => {
      const open = indexedDB.open("comic-downloader", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("handles");
      };
      open.onsuccess = () => {
        const transaction = open.result.transaction("handles", "readwrite");
        const store = transaction.objectStore("handles");
        store.put(mediaHandle, "last-directory:archiveofourown");
        store.put(mediaHandle, "last-directory:global");
        transaction.oncomplete = () => resolve(undefined);
        transaction.onerror = () => reject(transaction.error);
      };
      open.onerror = () => reject(open.error);
    });
  });
  await helper.close();
  console.log("Seeded a real OPFS directory handle for the folder restore path.");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchWithExtension(chromePath, profileDir, headless) {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless,
    userDataDir: profileDir,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--font-render-hinting=medium",
    ],
  });

  try {
    const workerTarget = await browser.waitForTarget(
      (target) =>
        target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
      { timeout: 15_000 },
    );
    return { browser, extensionId: new URL(workerTarget.url()).host };
  } catch {
    await browser.close();
    return null;
  }
}

async function framePanelPage(page) {
  await page.setViewport({ width: 440, height: 800, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
}

/** Looks up the extension's tab id for the content tab via a throwaway extension page. */
async function findTabId(browser, panelUrl, tabPattern) {
  const helper = await browser.newPage();
  await helper.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const tabId = await helper.evaluate(async (pattern) => {
    const tabs = await chrome.tabs.query({ url: pattern });
    return tabs[0]?.id ?? null;
  }, tabPattern);
  await helper.close();
  if (tabId === null) {
    throw new Error(`No open tab matched ${tabPattern} from the extension's point of view.`);
  }
  return tabId;
}

/** Opens the actual Chrome side panel for the given tab. Returns null when Chrome refuses
 * (for example the user-gesture requirement), so the caller can fall back. */
async function tryRealSidePanel(browser, panelUrl, tabId) {
  const helper = await browser.newPage();
  try {
    await helper.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await helper.evaluate(async (targetTabId) => {
      await chrome.sidePanel.open({ tabId: targetTabId });
    }, tabId);
  } catch (error) {
    console.warn(`Real side panel unavailable (${error.message.split("\n")[0]}); using fallback.`);
    await helper.close();
    return null;
  }

  const helperTarget = helper.target();
  const panelTarget = await browser
    .waitForTarget((target) => target.url() === panelUrl && target !== helperTarget, {
      timeout: 5_000,
    })
    .catch(() => null);
  await helper.close();
  if (!panelTarget) {
    console.warn("sidePanel.open() succeeded but no panel target appeared; using fallback.");
    return null;
  }
  return panelTarget.asPage();
}

/** Fallback: load the real side panel page in a tab, wrapping only chrome.tabs.query so the
 * active-tab lookup resolves to the real content tab. Storage, IndexedDB, and the controller
 * all run unmodified. */
async function openPanelWithActiveTabWrapper(browser, panelUrl, tabPattern) {
  const page = await browser.newPage();
  await framePanelPage(page);
  await page.evaluateOnNewDocument((pattern) => {
    const originalQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (queryInfo, callback) => {
      const wantsActiveTab =
        queryInfo != null && queryInfo.active === true && queryInfo.currentWindow === true;
      const result = wantsActiveTab ? originalQuery({ url: pattern }) : originalQuery(queryInfo);
      // chrome.tabs.query takes an optional trailing callback; absent means promise form.
      if (callback === undefined) {
        return result;
      }
      void result.then(callback);
      return undefined;
    };
  }, tabPattern);
  await page.goto(panelUrl, { waitUntil: "networkidle2", timeout: 30_000 });
  return page;
}

/** Navigates the content tab, retrying on slow responses. The panel only reads the tab's URL,
 * so a committed navigation is enough even when the page itself is still loading. */
async function loadContentPage(page, url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      if (page.url().startsWith(url)) {
        console.warn(`Content page ${url} is slow but the navigation committed; continuing.`);
        return;
      }
      console.warn(`Loading ${url} failed (attempt ${attempt + 1}/3): ${error.message}`);
      await sleep(3_000);
    }
  }
  throw new Error(`Could not load content page ${url}: ${lastError?.message}`);
}

async function captureShot(browser, panelUrl, shot) {
  const contentPage = await browser.newPage();
  await contentPage.setViewport({ width: 1280, height: 900 });
  await loadContentPage(contentPage, shot.contentUrl);

  const tabId = await findTabId(browser, panelUrl, shot.tabPattern);

  if (shot.seedFolderHandle) {
    await seedDirectoryHandle(browser, panelUrl);
  }

  let approach = "real side panel";
  let panelPage = await tryRealSidePanel(browser, panelUrl, tabId);
  if (panelPage) {
    await framePanelPage(panelPage).catch(() => {
      console.warn("Could not emulate viewport on the side panel; capturing at natural size.");
    });
  } else {
    approach = "tabs.query wrapper";
    panelPage = await openPanelWithActiveTabWrapper(browser, panelUrl, shot.tabPattern);
  }

  await panelPage.waitForFunction(shot.readyInPanel, { timeout: 20_000 });
  // Let the controller settle (it restores folder state and the last-run log asynchronously).
  await sleep(1000);
  const path = join(outputDir, shot.outFile);
  await panelPage.screenshot({ path, type: "png" });
  console.log(`Saved ${path} (${approach})`);

  if (shot.inBrowserOutFile) {
    await captureInBrowser(browser, contentPage, panelPage, join(outputDir, shot.inBrowserOutFile));
  }

  await panelPage.close().catch(() => {});
  await contentPage.close();
  return approach;
}

/** Window geometry for the in-browser composite, in CSS pixels at 2x. */
const windowFrame = {
  width: 1440,
  height: 900,
  chromeHeight: 80, // tab strip + toolbar
  panelWidth: 440,
  panelHeaderHeight: 40,
};

/**
 * Re-shoots the content tab and the panel at the sizes they occupy inside a 1440x900 Chrome
 * window, then lays them into a drawn window frame and saves the result.
 */
async function captureInBrowser(browser, contentPage, panelPage, path) {
  const contentHeight = windowFrame.height - windowFrame.chromeHeight;
  const pageWidth = windowFrame.width - windowFrame.panelWidth;
  const panelHeight = contentHeight - windowFrame.panelHeaderHeight;

  await contentPage.setViewport({ width: pageWidth, height: contentHeight, deviceScaleFactor: 2 });
  await acceptArchiveTerms(contentPage);
  await contentPage.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  const pageImage = await contentPage.screenshot({ type: "png", encoding: "base64" });
  const title = await contentPage.title();
  const url = contentPage.url();

  await panelPage
    .setViewport({ width: windowFrame.panelWidth, height: panelHeight, deviceScaleFactor: 2 })
    .catch(() => {
      console.warn("Could not resize the side panel for the composite; using its current size.");
    });
  await sleep(300);
  const panelImage = await panelPage.screenshot({ type: "png", encoding: "base64" });

  const composer = await browser.newPage();
  await composer.setViewport({
    width: windowFrame.width,
    height: windowFrame.height,
    deviceScaleFactor: 2,
  });
  await composer.setContent(browserFrameHtml({ pageImage, panelImage, title, url }), {
    waitUntil: "load",
  });
  await composer.screenshot({ path, type: "png" });
  await composer.close();
  console.log(`Saved ${path} (composited into a browser frame)`);
}

/**
 * AO3 covers the work with a terms-of-service prompt on a fresh profile. Accept it the way a
 * reader does (both checkboxes, then the button) so the composite shows the work itself.
 */
async function acceptArchiveTerms(page) {
  const accepted = await page.evaluate(() => {
    const prompt = document.getElementById("tos_prompt");
    if (prompt === null || getComputedStyle(prompt).display === "none") {
      return false;
    }
    for (const box of prompt.querySelectorAll("input[type=checkbox]")) {
      box.click();
    }
    document.getElementById("accept_tos")?.click();
    return true;
  });
  if (accepted) {
    await page
      .waitForFunction(
        () => {
          const prompt = document.getElementById("tos_prompt");
          return prompt === null || getComputedStyle(prompt).display === "none";
        },
        { timeout: 5_000 },
      )
      .catch(() => {
        console.warn("The AO3 terms prompt did not close; the composite may show it.");
      });
  }
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A dark-theme Chrome window: macOS window controls, one tab, toolbar, page, side panel. */
function browserFrameHtml({ pageImage, panelImage, title, url }) {
  const { width, height, chromeHeight, panelWidth, panelHeaderHeight } = windowFrame;
  const tabStripHeight = chromeHeight / 2;
  const displayUrl = url.replace(/^https?:\/\//, "");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #202124; }
  body { font: 13px/1 -apple-system, "Segoe UI", system-ui, sans-serif; color: #e8eaed; }
  .tabs { height: ${tabStripHeight}px; display: flex; align-items: flex-end; padding: 0 12px; gap: 8px; }
  .lights { display: flex; gap: 8px; align-self: center; margin-right: 8px; }
  .lights i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  .tab { height: 34px; max-width: 260px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
         background: #35363a; border-radius: 8px 8px 0 0; font-size: 12px; overflow: hidden; }
  .tab .favicon { width: 14px; height: 14px; border-radius: 3px; background: #990000; flex: none; }
  .tab span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tab b { font-weight: 400; color: #9aa0a6; margin-left: 6px; }
  .newtab { color: #9aa0a6; font-size: 18px; align-self: center; padding: 0 4px; }
  .toolbar { height: ${tabStripHeight}px; background: #35363a; display: flex; align-items: center;
             gap: 14px; padding: 0 12px; color: #9aa0a6; font-size: 16px; }
  .omnibox { flex: 1; height: 28px; border-radius: 14px; background: #202124; display: flex;
             align-items: center; padding: 0 14px; font-size: 13px; color: #e8eaed; gap: 8px; }
  .omnibox i { width: 12px; height: 12px; border: 1.5px solid #9aa0a6; border-radius: 3px; display: block; }
  .puzzle { width: 18px; height: 18px; border-radius: 4px; background: #5f6368; }
  .content { display: grid; grid-template-columns: 1fr ${panelWidth}px; height: ${height - chromeHeight}px; }
  .page img, .panel img { display: block; width: 100%; height: auto; }
  .page { overflow: hidden; background: #fff; }
  .panel { border-left: 1px solid #3c4043; background: #0a0a0c; display: grid;
           grid-template-rows: ${panelHeaderHeight}px 1fr; }
  .panel header { display: flex; align-items: center; justify-content: space-between;
                  padding: 0 16px; background: #202124; border-bottom: 1px solid #3c4043;
                  font-size: 13px; font-weight: 500; color: #e8eaed; }
  .panel header span { color: #9aa0a6; font-size: 16px; }
  .panel div { overflow: hidden; }
</style></head>
<body>
  <div class="tabs">
    <div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
    <div class="tab"><i class="favicon"></i><span>${escapeHtml(title)}</span><b>×</b></div>
    <div class="newtab">+</div>
  </div>
  <div class="toolbar">
    <span>←</span><span>→</span><span>↻</span>
    <div class="omnibox"><i></i>${escapeHtml(displayUrl)}</div>
    <div class="puzzle"></div><span>⋮</span>
  </div>
  <div class="content">
    <div class="page"><img src="data:image/png;base64,${pageImage}" alt=""></div>
    <div class="panel">
      <header>Gather Box<span>×</span></header>
      <div><img src="data:image/png;base64,${panelImage}" alt=""></div>
    </div>
  </div>
</body></html>`;
}

async function main() {
  if (!existsSync(join(extensionDir, "manifest.json"))) {
    throw new Error(
      `Extension build not found at ${extensionDir}. Run: pnpm --filter @latch-works/gather-box build`,
    );
  }

  const chromePath = process.env.CHROME_PATH ?? resolveBundledChrome();
  if (!chromePath || !existsSync(chromePath)) {
    throw new Error(
      "Chrome for Testing not found. Set CHROME_PATH or run: pnpm exec browsers install chrome@stable",
    );
  }

  mkdirSync(outputDir, { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), "gather-box-shots-"));
  let browser = null;

  try {
    let launched = await launchWithExtension(chromePath, profileDir, true);
    if (!launched) {
      console.warn("Extension did not load in headless Chrome; retrying headed.");
      rmSync(profileDir, { recursive: true, force: true });
      mkdirSync(profileDir, { recursive: true });
      launched = await launchWithExtension(chromePath, profileDir, false);
    }
    if (!launched) {
      throw new Error("Gather Box service worker never started; the extension failed to load.");
    }

    browser = launched.browser;
    const panelUrl = `chrome-extension://${launched.extensionId}/sidepanel/sidepanel.html`;
    for (const shot of shots) {
      await captureShot(browser, panelUrl, shot);
    }
    console.log("Gather Box capture complete.");
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
