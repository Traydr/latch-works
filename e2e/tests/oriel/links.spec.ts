import path from "node:path";
import { expect, test } from "@playwright/test";
import { FIXTURE_ARCHIVE_DIR } from "../../src/env.ts";
import { tiles, waitForScan } from "../../src/frame-view.ts";
import { chooseFolder, waitForJobs } from "../../src/glazier.ts";
import { launchOriel, type OrielSession, openMode } from "../../src/oriel.ts";

let session: OrielSession | undefined;

test.afterEach(async () => {
  await session?.app.close();
  session = undefined;
});

test("a folder Tidy tidies is offered to View, and the modes hand files and folders on", async () => {
  test.setTimeout(120_000);
  session = await launchOriel(undefined, { ORIEL_DISABLE_GPU: "1" });
  const { window } = session;
  const folderTitle = window.getByText("Folder: archive", { exact: true });

  await openMode(window, "tidy");
  await window.getByRole("button", { name: /Choose folder/i }).click();
  await chooseFolder(window, FIXTURE_ARCHIVE_DIR);
  await waitForJobs(window);

  // View has no folder of its own yet, so it offers the one Tidy tidies.
  await openMode(window, "view");
  await window.locator("[data-offered-folder]:visible").first().click();
  await expect(folderTitle).toBeVisible();

  // View's folder menu starts a Sync profile for the folder on screen.
  await window.getByRole("button", { name: "Folder actions" }).click();
  await window.getByRole("menuitem", { name: "Sync this folder" }).click();
  await expect(window).toHaveTitle("Sync – Oriel");
  await expect(window.locator("#profile-source-root")).toHaveValue(FIXTURE_ARCHIVE_DIR);
  await expect(window.getByLabel("Profile name")).toHaveValue("archive");

  // The viewer shows its file in Tidy, at the Library filtered to it.
  await openMode(window, "view");
  await window
    .locator(`[data-gallery-item][title='${path.join(FIXTURE_ARCHIVE_DIR, "bulk")}']`)
    .dblclick();
  await expect(window.getByText("Folder: bulk", { exact: true })).toBeVisible();
  await waitForScan(window);
  await tiles(window).first().dblclick();
  await expect(window.getByRole("dialog", { name: "Viewer for bulk-001.png" })).toBeVisible();
  await window.getByRole("button", { name: "Show in Tidy" }).click();
  await expect(window).toHaveTitle("Tidy – Oriel");
  await expect(window.getByLabel("Search names and folders")).toHaveValue("bulk-001.png");

  // Tidy's Inspector opens the file in View's viewer.
  await window.locator("main [aria-selected]:visible").first().click();

  if (
    (await window.getByRole("button", { name: "Inspector" }).getAttribute("aria-pressed")) !==
    "true"
  ) {
    await window.getByRole("button", { name: "Inspector" }).click();
  }

  await window.getByRole("button", { name: "Open in View", exact: true }).click();
  await expect(window).toHaveTitle("View – Oriel");
  await expect(window.getByRole("dialog", { name: "Viewer for bulk-001.png" })).toBeVisible();
  await window.keyboard.press("Escape");

  // Tidy's Overview opens the whole folder in View.
  await openMode(window, "tidy");
  await window.getByRole("button", { name: "Overview" }).click();
  await window.getByRole("button", { name: "Open in View", exact: true }).click();
  await expect(window).toHaveTitle("View – Oriel");
  await expect(folderTitle).toBeVisible();
});
