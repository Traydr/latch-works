import { expect, type Page, test } from "@playwright/test";
import { PANE_VIEW_CREDENTIALS } from "../../src/env.ts";
import { card, gotoBrowse, openViewer } from "../../src/pane-view.ts";

/**
 * Plan 066, phase 3: the two flows that break in a Home Screen app, which has no address bar or
 * tabs to recover with.
 */

async function signIn(page: Page): Promise<void> {
  await page.getByLabel("Username").fill(PANE_VIEW_CREDENTIALS.username);
  await page.getByLabel("Password").fill(PANE_VIEW_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Chromium cannot emulate `display-mode: standalone`, so the page is told it matches. */
async function runAsHomeScreenApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);

    window.matchMedia = (query) =>
      query === "(display-mode: standalone)"
        ? { ...matchMedia(query), matches: true, media: query }
        : matchMedia(query);
  });
}

test.describe("sign-in return path", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a signed-out link to a folder returns to it after signing in", async ({ page }) => {
    await page.goto("/?path=mixed");
    await expect(page).toHaveURL(/\/login\?redirect=%2F%3Fpath%3Dmixed$/);

    await signIn(page);
    await expect(page).toHaveURL(/\/\?path=mixed$/);
    await expect(card(page, "mixed/photo-1.jpg")).toBeVisible();
  });

  // Better Auth allows three sign-ins in ten seconds, so this one checks what a failed attempt
  // keeps rather than signing in again. Unsafe return paths are covered by return-path.test.ts.
  test("a wrong password keeps the return path for the next attempt", async ({ page }) => {
    await page.goto("/login?redirect=%2F%3Fpath%3Dmixed");
    await page.getByLabel("Username").fill(PANE_VIEW_CREDENTIALS.username);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login\?error=invalid&redirect=%2F%3Fpath%3Dmixed$/);
    await expect(page.locator('input[name="redirect"]')).toHaveValue("/?path=mixed");
  });
});

test.describe("a session that lapses while browsing", () => {
  test("sends the app to sign in, then back to the folder it was opening", async ({
    context,
    page,
  }) => {
    await gotoBrowse(page);
    await context.clearCookies();

    await page
      .getByRole("list", { name: "Archive folders" })
      .getByTitle("mixed", { exact: true })
      .click();
    await expect(page).toHaveURL(/\/login\?redirect=%2F%3Fpath%3Dmixed$/);

    await signIn(page);
    await expect(page).toHaveURL(/\/\?path=mixed$/);
    await expect(card(page, "mixed/photo-1.jpg")).toBeVisible();
  });
});

test.describe("Download", () => {
  test("in a browser, opens the original in a new tab", async ({ context, page }) => {
    await gotoBrowse(page, { path: "mixed" });
    const viewer = await openViewer(page, "mixed/photo-1.jpg");
    const popup = context.waitForEvent("page");
    await viewer.getByRole("button", { name: "Download" }).click();
    expect((await popup).url()).not.toBe(page.url());
    await expect(viewer).toBeVisible();
  });

  test("in the installed app, shows the original over the viewer with a way back", async ({
    page,
  }) => {
    await runAsHomeScreenApp(page);
    await gotoBrowse(page, { path: "mixed" });
    const viewer = await openViewer(page, "mixed/photo-1.jpg");

    await viewer.getByRole("button", { name: "Download" }).click();
    const original = page.getByRole("dialog", { name: "Original of photo-1.jpg" });
    await expect(original).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);

    const image = original.getByRole("img", { name: "photo-1.jpg" });
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);

    // The viewer's window-wide keys stay quiet under the dialog: an arrow does not step it.
    await page.keyboard.press("ArrowRight");
    await original.getByRole("button", { name: "Back" }).click();
    await expect(original).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Viewer for photo-1.jpg" })).toBeVisible();
  });
});
