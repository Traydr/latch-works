import { expect, test } from "@playwright/test";
import { FIXTURE_ARCHIVE_DIR } from "../../src/env.ts";
import { openFolder, tiles, waitForScan } from "../../src/frame-view.ts";
import { chooseFolder, waitForJobs } from "../../src/glazier.ts";
import {
  chooseModeFromMenu,
  clickMenuItem,
  expectModeShown,
  launchOriel,
  type OrielSession,
  openMode,
} from "../../src/oriel.ts";

let session: OrielSession | undefined;

test.afterEach(async () => {
  await session?.app.close();
  session = undefined;
});

test("starts in View and switches modes from the switcher and the menu", async () => {
  session = await launchOriel();
  const { app, window } = session;

  await expect(window).toHaveTitle("View – Oriel");
  await expectModeShown(window, "view");

  await openMode(window, "tidy");
  await expectModeShown(window, "tidy");
  const tidyWelcome = window.getByRole("heading", { name: "Choose your media archive" });

  await expect(tidyWelcome).toBeVisible();

  await chooseModeFromMenu(app, "sync");
  await expect(window).toHaveTitle("Sync – Oriel");
  await expect(window.getByRole("navigation", { name: "Profiles" })).toBeVisible();
  await expect(tidyWelcome).toBeHidden();

  // The menu's check mark follows the mode the window shows.
  const checked = await app.evaluate(({ Menu }) =>
    ["view", "tidy", "sync"].filter(
      (mode) => Menu.getApplicationMenu()?.getMenuItemById(`mode-${mode}`)?.checked,
    ),
  );

  expect(checked).toEqual(["sync"]);
});

test("reopens in the mode it showed last", async () => {
  session = await launchOriel();
  await openMode(session.window, "sync");
  const { userDataDir } = session;
  await session.app.close();

  session = await launchOriel(userDataDir);
  await expect(session.window).toHaveTitle("Sync – Oriel");
});

test("reopens on the page it showed last, with View able to step back up", async () => {
  test.setTimeout(120_000);
  session = await launchOriel(undefined, { ORIEL_DISABLE_GPU: "1" });
  const { window, userDataDir } = session;
  const heading = (name: string) => window.getByRole("heading", { level: 1, name, exact: true });

  await openFolder(session, FIXTURE_ARCHIVE_DIR);
  await window.locator('[data-sidebar-folder="comics"]').click();
  await expect(heading("comics")).toBeVisible();
  await waitForScan(window);

  await openMode(window, "tidy");
  await window.getByRole("button", { name: /Choose folder/i }).click();
  await chooseFolder(window, FIXTURE_ARCHIVE_DIR);
  await waitForJobs(window);
  await window.getByRole("button", { name: "Library", exact: true }).click();
  await expect(window.getByLabel("Search names and folders")).toBeVisible();
  await session.app.close();

  session = await launchOriel(userDataDir, { ORIEL_DISABLE_GPU: "1" });
  const reopened = session.window;

  const reopenedHeading = (name: string) =>
    reopened.getByRole("heading", { level: 1, name, exact: true });

  await expect(reopened).toHaveTitle("Tidy – Oriel");
  await expect(reopened.getByLabel("Search names and folders")).toBeVisible();

  // View is back in the subfolder, and the folder opened above it is still the top.
  await openMode(reopened, "view");
  await expect(reopenedHeading("comics")).toBeVisible();
  await reopened.locator("[data-sidebar-parent]").click();
  await expect(reopenedHeading("archive")).toBeVisible();
});

test("View keeps its folder while another mode shows", async () => {
  session = await launchOriel(undefined, { ORIEL_DISABLE_GPU: "1" });
  const { window } = session;

  await openFolder(session, FIXTURE_ARCHIVE_DIR);
  const shown = await tiles(window).count();

  expect(shown).toBeGreaterThan(0);

  await openMode(window, "tidy");
  await expect(tiles(window).first()).toBeHidden();

  await openMode(window, "view");
  await expect(tiles(window)).toHaveCount(shown);
});

test("one Settings page, at the section of the mode on screen", async () => {
  session = await launchOriel();
  const { app, window } = session;
  const title = window.getByRole("heading", { level: 1 });
  const done = window.getByRole("button", { name: /^Back to / });

  // View's sidebar item opens View's section, which holds Frame View's preferences.
  await window.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(title).toHaveText("View");
  await expect(window.getByRole("switch", { name: "Show videos" })).toBeVisible();

  // General holds the one theme.
  await window.locator('[data-settings-section="general"]').click();
  await expect(title).toHaveText("General");
  await window.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
  await expect(window.locator("html")).toHaveClass(/\bdark\b/);

  await done.click();
  await expect(done).toBeHidden();
  await expect(window.getByRole("button", { name: "Settings", exact: true })).toBeVisible();

  // ⌘, opens the section of whichever mode shows.
  await openMode(window, "sync");
  await clickMenuItem(app, "settings");
  await expect(title).toHaveText("Sync");
  await expect(window.getByRole("button", { name: "Add profile", exact: true })).toBeVisible();

  // Choosing another mode's section shows that mode underneath; Escape closes Settings.
  await window.locator('[data-settings-section="tidy"]').click();
  await expect(title).toHaveText("Tidy");
  await expect(window).toHaveTitle("Tidy – Oriel");
  await window.keyboard.press("Escape");
  await expect(done).toBeHidden();
  await expect(window.getByRole("heading", { name: "Choose your media archive" })).toBeVisible();
});
