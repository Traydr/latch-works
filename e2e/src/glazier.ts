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

  return { app, window };
}

/** Points the native folder picker at `folder` for the next pick, from the main process. */
export async function stubFolderDialog(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, folder);
}

/**
 * Waits for the work an action just started. The job bar lists queued and running jobs; a job
 * can take a moment to appear after its button is pressed, so this first gives it up to two
 * seconds to show, then waits for the bar to empty.
 */
export async function waitForJobs(window: Page, timeout = 120_000): Promise<void> {
  const jobs = window.locator('[data-testid="job-bar"] [data-job-state]');
  await jobs
    .first()
    .waitFor({ state: "attached", timeout: 2000 })
    .catch(() => undefined);
  await expect(jobs).toHaveCount(0, { timeout });
}

export async function openView(window: Page, label: string): Promise<void> {
  await window
    .getByRole("navigation", { name: "Glazier" })
    .getByRole("button", { name: label, exact: true })
    .click();
}

/** Applies the plan in the review dialog, then waits for the engine to finish it. */
export async function applyPlan(window: Page): Promise<void> {
  const dialog = window.getByRole("dialog");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toHaveCount(0);
  await waitForJobs(window);
}
