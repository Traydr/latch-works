import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { FIXTURE_ARCHIVE_DIR } from "../../src/env.ts";
import { tiles } from "../../src/frame-view.ts";
import { launchOriel, type OrielSession, openMode } from "../../src/oriel.ts";

let session: OrielSession | undefined;

test.afterEach(async () => {
  await session?.app.close();
  session = undefined;
});

test("the first start's welcome sets one folder up for View and Tidy, then shows no more", async () => {
  // A home of its own: Sync reads the Lockstep CLI's ~/.latch-works config, whose folders would
  // count as already brought over.
  const home = await mkdtemp(path.join(os.tmpdir(), "oriel-home-"));
  const env = { HOME: home, ORIEL_WELCOME: "1", ORIEL_DISABLE_GPU: "1" };

  session = await launchOriel(undefined, env);
  const { app, window, userDataDir } = session;
  const welcome = window.getByRole("region", { name: "Welcome to Oriel" });

  await expect(welcome).toBeVisible();

  // The native folder dialog, answered as the owner would.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, FIXTURE_ARCHIVE_DIR);

  await welcome.getByRole("button", { name: "Choose Folder…" }).click();
  await expect(welcome.getByText(FIXTURE_ARCHIVE_DIR, { exact: true })).toBeVisible();
  await expect(welcome.getByRole("switch", { name: "Tidy it" })).toBeChecked();
  await welcome.getByRole("button", { name: "Start" }).click();

  // It lands in View, scanning the folder, and Tidy has it too.
  await expect(welcome).toBeHidden();
  await expect(window).toHaveTitle("View – Oriel");
  await expect(window.getByText("Folder: archive", { exact: true })).toBeVisible();
  await expect(tiles(window).first()).toBeVisible();
  await openMode(window, "tidy");
  await expect(window.getByRole("button", { name: /^archive/ }).first()).toBeVisible();

  await app.close();
  session = await launchOriel(userDataDir, env);
  await expect(session.window.getByRole("region", { name: "Welcome to Oriel" })).toHaveCount(0);
});

test("the welcome stays away under the e2e suite's own data folder", async () => {
  session = await launchOriel();
  await expect(session.window.getByRole("region", { name: "Welcome to Oriel" })).toHaveCount(0);
});
