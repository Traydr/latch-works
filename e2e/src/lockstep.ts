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
 * Drives the packaged Lockstep desktop build (`apps/lockstep/.vite/build`,
 * produced by `electron-forge package` in the setup project) through
 * Playwright's Electron driver on a fresh userData directory. Tokens are
 * encrypted with the file key under `~/.config/lockstep` rather than the
 * Keychain, whose prompt would block the run until someone clicks Allow.
 */
export const LOCKSTEP_APP_DIR = path.join(REPO_ROOT, "apps", "lockstep");

const ELECTRON_BINARY = path.join(
  LOCKSTEP_APP_DIR,
  "node_modules",
  "electron",
  "dist",
  process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron",
);

export interface LockstepSession {
  app: ElectronApplication;
  userDataDir: string;
  window: Page;
}

export async function launchLockstep(): Promise<LockstepSession> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-e2e-"));

  const app = await electron.launch({
    args: [
      path.join(LOCKSTEP_APP_DIR, ".vite", "build", "main.js"),
      `--user-data-dir=${userDataDir}`,
    ],
    cwd: LOCKSTEP_APP_DIR,
    env: electronChildEnv({ LOCKSTEP_SECRET_STORAGE: "file" }),
    executablePath: ELECTRON_BINARY,
  });

  const window = await app.firstWindow();
  await expect(window.getByText("Lockstep", { exact: true }).first()).toBeVisible();

  return { app, userDataDir, window };
}

/**
 * A sync action button. Plan, Push, and Prune sit in the plan header (Plan is the empty state's
 * button before the first plan); each carries a `data-action` naming its action. The run panel's
 * Prune shares the attribute, so take the header's, which comes first.
 */
export function actionButton(window: Page, action: "plan" | "push" | "prune") {
  return window.locator(`button[data-action="${action}"]`).first();
}

/** A run panel stat, such as "pushed 8 / 17" or "failed 0": the count before any "/ total". */
export async function readStat(
  window: Page,
  label: "pushed" | "deleted" | "failed",
): Promise<string> {
  const value = await window.locator(`[data-stat="${label}"]`).innerText();

  return value.split("/")[0]?.trim() ?? "";
}

/** One of the plan's change counts, from the header chips or the "unchanged" footer. */
export async function readPlanCount(
  window: Page,
  action: "upload" | "update" | "delete" | "keep",
): Promise<string> {
  return (await window.locator(`[data-plan-count="${action}"]`).getAttribute("data-count")) ?? "";
}

/** Closes the finished run's panel, as the user does after reading the result. */
export async function dismissRunPanel(window: Page): Promise<void> {
  await window.getByRole("button", { name: "Done", exact: true }).click();
}
