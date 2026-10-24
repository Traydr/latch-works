import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { launchOriel, openMode } from "./oriel.ts";

/**
 * Drives Tidy, Glazier as one of Oriel's modes, in the packaged Oriel build on a fresh userData
 * directory.
 */
export interface GlazierSession {
  app: ElectronApplication;
  window: Page;
  /** Tidy's data folder for this run, where the catalog and holding live: `glazier/` in Oriel's. */
  userDataDir: string;
}

export async function launchGlazier(): Promise<GlazierSession> {
  const { app, window, userDataDir } = await launchOriel();

  await openMode(window, "tidy");
  await expect(window.getByRole("heading", { name: "Choose your media archive" })).toBeVisible();

  return { app, window, userDataDir: path.join(userDataDir, "glazier") };
}

/**
 * Picks `folder` in Glazier's own folder picker, which the click before this opened: types its
 * path into the path field, waits for the listing to catch up, and chooses it.
 */
export async function chooseFolder(window: Page, folder: string): Promise<void> {
  const choose = window.locator("[data-folder-choose]");

  await window.locator("[data-folder-path]").fill(`${folder}${path.sep}`);
  await expect(choose).toContainText(`“${path.basename(folder)}”`);
  await choose.click();
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
