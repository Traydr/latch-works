import { expect, test } from "@playwright/test";
import {
  chooseModeFromMenu,
  launchOriel,
  modeButton,
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
  await expect(modeButton(window, "view")).toHaveAttribute("aria-current", "page");

  await openMode(window, "tidy");
  await expect(modeButton(window, "tidy")).toHaveAttribute("aria-current", "page");
  await expect(window.getByText("Glazier moves in here.")).toBeVisible();

  await chooseModeFromMenu(app, "sync");
  await expect(window).toHaveTitle("Sync – Oriel");
  await expect(window.getByRole("navigation", { name: "Profiles" })).toBeVisible();
  await expect(window.getByText("Glazier moves in here.")).toBeHidden();

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
