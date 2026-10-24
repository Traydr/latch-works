import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
} from "@playwright/test";
import { electronChildEnv, REPO_ROOT } from "./env.ts";

/**
 * Drives the packaged Oriel build (`apps/oriel/.vite/build`, produced by `electron-forge package`
 * in the setup project) on a fresh userData directory.
 */
export const ORIEL_APP_DIR = path.join(REPO_ROOT, "apps", "oriel");

const ELECTRON_BINARY = path.join(
  ORIEL_APP_DIR,
  "node_modules",
  "electron",
  "dist",
  process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron",
);

export type OrielMode = "view" | "tidy" | "sync";

export interface OrielSession {
  app: ElectronApplication;
  window: Page;
  /** Oriel's data folder for this run. */
  userDataDir: string;
}

/** Oriel's window, found by its page: Tidy opens a hidden transcoder window beside it. */
async function findMainWindow(app: ElectronApplication): Promise<Page> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const page = app.windows().find((candidate) => candidate.url().endsWith("index.html"));

    if (page) {
      return page;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("Oriel's main window never opened.");
}

/** Launches Oriel on `userDataDir`, or on a fresh one, with `env` added to the environment. */
export async function launchOriel(
  userDataDir?: string,
  env: Record<string, string> = {},
): Promise<OrielSession> {
  const dataDir = userDataDir ?? (await mkdtemp(path.join(os.tmpdir(), "oriel-e2e-")));

  const app = await electron.launch({
    args: [path.join(ORIEL_APP_DIR, ".vite", "build", "main.cjs"), `--user-data-dir=${dataDir}`],
    cwd: ORIEL_APP_DIR,
    env: electronChildEnv(env),
    executablePath: ELECTRON_BINARY,
  });

  const window = await findMainWindow(app);
  await window.setViewportSize({ width: 1320, height: 860 });
  await expect(modeButton(window, "view")).toBeVisible();

  return { app, window, userDataDir: dataDir };
}

/** The showing mode's switcher button for `mode`; hidden modes keep switchers of their own. */
function modeButton(window: Page, mode: OrielMode) {
  return window.locator(`[data-mode="${mode}"]:visible`);
}

/**
 * Waits until `mode`'s switcher button shows as the mode on screen: pressed in the full sidebar's
 * segmented control, the current page in the rail.
 */
export async function expectModeShown(window: Page, mode: OrielMode): Promise<void> {
  const button = modeButton(window, mode);

  await expect
    .poll(
      async () =>
        (await button.getAttribute("aria-pressed")) === "true" ||
        (await button.getAttribute("aria-current")) === "page",
    )
    .toBe(true);
}

/** Opens `mode` from the switcher and waits until it shows. */
export async function openMode(window: Page, mode: OrielMode): Promise<void> {
  await modeButton(window, mode).click();
  await expect(window).toHaveTitle(new RegExp(`^${modeLabel(mode)} – Oriel$`));
}

/** Clicks the app menu's item with `id`, as its shortcut does. */
export async function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);

    if (!item) {
      throw new Error(`No menu item ${itemId}`);
    }

    item.click();
  }, id);
}

/** Clicks the View menu's entry for `mode`, as ⌘1–3 does. */
export async function chooseModeFromMenu(app: ElectronApplication, mode: OrielMode): Promise<void> {
  await clickMenuItem(app, `mode-${mode}`);
}

function modeLabel(mode: OrielMode): string {
  switch (mode) {
    case "view":
      return "View";
    case "tidy":
      return "Tidy";
    case "sync":
      return "Sync";
    default: {
      const _exhaustive: never = mode;

      return _exhaustive;
    }
  }
}
