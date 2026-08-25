import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { electronChildEnv, REPO_ROOT } from "./env.ts";

/**
 * Drives the packaged Frame View build (`.vite/build`, produced by
 * `electron-forge package` in the setup project) through Playwright's
 * Electron driver. Every launch gets its own userData directory so settings,
 * the remembered folder and the thumbnail cache start empty unless a test
 * hands the same directory to a second launch.
 */
export const FRAME_VIEW_DIR = path.join(REPO_ROOT, "apps", "frame-view");
const ELECTRON_BINARY = path.join(
  FRAME_VIEW_DIR,
  "node_modules",
  "electron",
  "dist",
  process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron",
);

export interface FrameViewSession {
  app: ElectronApplication;
  userDataDir: string;
  window: Page;
}

async function newUserDataDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "frame-view-e2e-"));
}

export async function launchFrameView(userDataDir?: string): Promise<FrameViewSession> {
  const dataDir = userDataDir ?? (await newUserDataDir());
  const app = await electron.launch({
    args: [path.join(FRAME_VIEW_DIR, ".vite", "build", "main.js"), `--user-data-dir=${dataDir}`],
    cwd: FRAME_VIEW_DIR,
    env: electronChildEnv({ FRAME_VIEW_DISABLE_GPU: "1" }),
    executablePath: ELECTRON_BINARY,
  });
  const window = await app.firstWindow();
  await expect(window.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  return { app, userDataDir: dataDir, window };
}

/**
 * Points the native folder picker at `folder` for the next "Open" click. The
 * IPC runtime calls `dialog.showOpenDialog` at click time, so replacing it on
 * the main-process module is enough; no product hook is needed.
 */
async function stubFolderDialog(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, folder);
}

export async function openFolder(session: FrameViewSession, folder: string): Promise<void> {
  await stubFolderDialog(session.app, folder);
  await session.window.getByRole("button", { name: "Open", exact: true }).click();
  // Every fixture folder has at least one entry; the grid filling is the scan landing.
  await expect.poll(() => tiles(session.window).count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await waitForScan(session.window);
}

/** The header shows a pulsing "scanning" pill while a scan runs. */
export async function waitForScan(window: Page): Promise<void> {
  await expect(window.getByText(/Scanning|Checking folder contents/)).toHaveCount(0, {
    timeout: 30_000,
  });
}

export function tiles(window: Page): Locator {
  return window.locator("[data-gallery-item]");
}

/** Tile keys are `<kind>:<absolute path>[:<size>:<mtime>]`; the path is what tests compare. */
function tilePath(key: string): string {
  return key.replace(/^[a-z]+:/, "").replace(/:\d+:\d+$/, "");
}

interface PositionedTile {
  key: string;
  left: number;
  top: number;
}

async function visibleTiles(window: Page): Promise<PositionedTile[]> {
  return tiles(window).evaluateAll((elements) =>
    elements.map((element) => {
      const tile = element instanceof HTMLElement ? element : null;
      return {
        key: element.getAttribute("data-gallery-item-id") ?? "",
        left: Number.parseFloat(tile?.style.left ?? "0"),
        top: Number.parseFloat(tile?.style.top ?? "0"),
      };
    }),
  );
}

/**
 * Gallery tile paths in visual order. The grid is virtualised, so this scrolls
 * the container from top to bottom and merges what each window renders; tile
 * offsets are absolute within the grid, so (top, left) orders the union.
 */
export async function readTileKeys(window: Page): Promise<string[]> {
  const container = window.locator("[data-gallery-scroll-container]");
  const seen = new Map<string, PositionedTile>();
  const scrollHeight = await container.evaluate((element) => element.scrollHeight);
  const step = await container.evaluate((element) => Math.max(200, element.clientHeight - 100));
  for (let offset = 0; offset <= scrollHeight; offset += step) {
    await container.evaluate((element, top) => {
      element.scrollTop = top;
    }, offset);
    // Give the windowed grid one frame to commit the new row window.
    await window.waitForTimeout(50);
    for (const tile of await visibleTiles(window)) seen.set(tile.key, tile);
  }
  await container.evaluate((element) => {
    element.scrollTop = 0;
  });
  return [...seen.values()]
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .map((tile) => tilePath(tile.key));
}

export async function expectTileCount(window: Page, count: number): Promise<void> {
  await expect
    .poll(async () => (await readTileKeys(window)).length, { timeout: 30_000 })
    .toBe(count);
}

export async function expectPill(window: Page, text: string): Promise<void> {
  await expect(window.getByText(text, { exact: true })).toBeVisible({ timeout: 30_000 });
}

export type FrameSortLabel = "A-Z" | "Z-A" | "Newest" | "Oldest" | "Random";

export async function chooseSort(window: Page, label: FrameSortLabel): Promise<void> {
  await window.locator("[aria-haspopup='menu']").click();
  await window.getByRole("menuitemradio", { name: label }).click();
}

export function tileFor(window: Page, name: string): Locator {
  return tiles(window).filter({ has: window.getByRole("img", { name, exact: true }) });
}

export async function openSettingsTab(window: Page, tab: "Usability" | "Debug"): Promise<void> {
  await window.getByRole("button", { name: "Settings", exact: true }).click();
  await window.getByRole("button", { name: tab, exact: true }).click();
}

export async function closeSettings(window: Page): Promise<void> {
  await window.getByRole("button", { name: "Close settings" }).click({ position: { x: 4, y: 4 } });
}

export async function setToggle(window: Page, label: string, on: boolean): Promise<void> {
  const toggle = window.getByLabel(label, { exact: true });
  if ((await toggle.isChecked()) !== on) await toggle.click();
}
