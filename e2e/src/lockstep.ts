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
 * Playwright's Electron driver on a fresh userData directory.
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
    env: electronChildEnv(),
    executablePath: ELECTRON_BINARY,
  });
  const window = await app.firstWindow();
  await expect(window.getByText("Lockstep", { exact: true }).first()).toBeVisible();
  return { app, userDataDir, window };
}

/**
 * The pipeline stage buttons live in the docked command surface and render a
 * badge (their number, or ✓ once done) before the label. The "Plan" tab above
 * shares the name, so match on the badge + label text inside the dock.
 */
export function stageButton(window: Page, label: "Plan" | "Review" | "Push" | "Prune") {
  return window
    .locator("div.h-44")
    .locator("button", { hasText: new RegExp(`^\\s*(\\d|✓)\\s*${label}\\s*$`) });
}

/** A dashboard stat: the number rendered next to its lowercase label. */
export async function readStat(
  window: Page,
  label: "files" | "pushed" | "failed",
): Promise<string> {
  // The label is upper-cased by CSS; innerText follows the transform, so take the last token.
  const stat = window.getByText(label, { exact: true }).locator("..");
  return (await stat.innerText()).trim().split(/\s+/).pop() ?? "";
}
