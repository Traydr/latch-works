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

/** Launches Oriel on `userDataDir`, or on a fresh one. */
export async function launchOriel(userDataDir?: string): Promise<OrielSession> {
  const dataDir = userDataDir ?? (await mkdtemp(path.join(os.tmpdir(), "oriel-e2e-")));

  const app = await electron.launch({
    args: [path.join(ORIEL_APP_DIR, ".vite", "build", "main.cjs"), `--user-data-dir=${dataDir}`],
    cwd: ORIEL_APP_DIR,
    env: electronChildEnv(),
    executablePath: ELECTRON_BINARY,
  });

  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1320, height: 860 });
  await expect(modeButton(window, "view")).toBeVisible();

  return { app, window, userDataDir: dataDir };
}

/** The showing mode's switcher button for `mode`; hidden modes keep switchers of their own. */
export function modeButton(window: Page, mode: OrielMode) {
  return window.locator(`[data-mode="${mode}"]:visible`);
}

/** Opens `mode` from the switcher and waits until it shows. */
export async function openMode(window: Page, mode: OrielMode): Promise<void> {
  await modeButton(window, mode).click();
  await expect(window).toHaveTitle(new RegExp(`^${modeLabel(mode)} – Oriel$`));
}

/** Clicks the View menu's entry for `mode`, as ⌘1–3 does. */
export async function chooseModeFromMenu(app: ElectronApplication, mode: OrielMode): Promise<void> {
  await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);

    if (!item) {
      throw new Error(`No menu item ${id}`);
    }

    item.click();
  }, `mode-${mode}`);
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
