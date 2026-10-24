import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { launchOriel, openMode } from "./oriel.ts";

/**
 * Drives Sync, Lockstep's desktop app as one of Oriel's modes, in the packaged Oriel build on a
 * fresh userData directory. Sync encrypts tokens with a key file in its own data folder, so no
 * Keychain prompt blocks the run.
 */
export interface LockstepSession {
  app: ElectronApplication;
  /** Sync's data folder for this run: `lockstep/` inside Oriel's. */
  userDataDir: string;
  window: Page;
}

export async function launchLockstep(): Promise<LockstepSession> {
  const { app, window, userDataDir } = await launchOriel();

  await openMode(window, "sync");
  await expect(window.getByRole("navigation", { name: "Profiles" })).toBeVisible();

  return { app, userDataDir: path.join(userDataDir, "lockstep"), window };
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
