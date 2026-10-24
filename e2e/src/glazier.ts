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
 * Drives the packaged Glazier build (`apps/glazier/.vite/build`, produced by `electron-forge
 * package` in the setup project) on a fresh userData directory. Glazier opens a hidden transcoder
 * window beside its main one, so the main window is found by its page rather than taken first.
 */
export const GLAZIER_APP_DIR = path.join(REPO_ROOT, "apps", "glazier");

const ELECTRON_BINARY = path.join(
  GLAZIER_APP_DIR,
  "node_modules",
  "electron",
  "dist",
  process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron",
);

export interface GlazierSession {
  app: ElectronApplication;
  window: Page;
  /** Glazier's data folder for this run, where the catalog and holding live. */
  userDataDir: string;
}

async function findMainWindow(app: ElectronApplication): Promise<Page> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const page = app.windows().find((candidate) => candidate.url().endsWith("index.html"));

    if (page) {
      return page;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("Glazier's main window never opened.");
}

export async function launchGlazier(): Promise<GlazierSession> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "glazier-e2e-"));

  const app = await electron.launch({
    args: [
      path.join(GLAZIER_APP_DIR, ".vite", "build", "main.cjs"),
      `--user-data-dir=${userDataDir}`,
    ],
    cwd: GLAZIER_APP_DIR,
    env: electronChildEnv(),
    executablePath: ELECTRON_BINARY,
  });

  const window = await findMainWindow(app);
  await window.setViewportSize({ width: 1320, height: 860 });

  return { app, window, userDataDir };
}

/** Points the native folder picker at `folder` for the next pick, from the main process. */
export async function stubFolderDialog(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, folder);
}

/**
 * Waits for the work an action just started, and for the background analysis that follows it.
 * The sidebar's job card names the running job; a job can take a moment to start after its button
 * is pressed, and the next one (analysis after a scan) a moment after the last ends, so this gives
 * a job up to two seconds to show and then needs the card gone twice in a row.
 */
export async function waitForJobs(window: Page, timeout = 180_000): Promise<void> {
  const busy = window.locator('[data-testid="activity"][data-job-state]');

  await busy.waitFor({ state: "attached", timeout: 2000 }).catch(() => undefined);

  await expect
    .poll(
      async () => {
        if ((await busy.count()) > 0) {
          return false;
        }

        await new Promise((resolve) => setTimeout(resolve, 400));

        return (await busy.count()) === 0;
      },
      { timeout, intervals: [200] },
    )
    .toBe(true);
}

export type GlazierView =
  | "overview"
  | "duplicates"
  | "convert"
  | "cleanup"
  | "library"
  | "history"
  | "holding"
  | "settings";

export async function openView(window: Page, view: GlazierView): Promise<void> {
  await window.locator(`nav [data-view="${view}"]`).click();
}

/** The newest result toast, which every applied change shows with its Undo. */
export function latestToast(window: Page) {
  return window.locator("[data-toast]").last();
}
