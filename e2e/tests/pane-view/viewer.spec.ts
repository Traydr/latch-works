import { expect, test } from "@playwright/test";
import { fixtureItemsInScope, sortFixtureItems } from "../../src/fixture.ts";
import {
  archiveBrowser,
  card,
  closeSettings,
  expectEntryCount,
  gotoBrowse,
  loadAllPages,
  openSettings,
  openViewer,
  setSettingToggle,
  viewerFor,
} from "../../src/pane-view.ts";

const ALPHA = sortFixtureItems(fixtureItemsInScope("comics/alpha", false), "name-asc").map(
  (entry) => entry.name,
);
const BULK = sortFixtureItems(fixtureItemsInScope("bulk", false), "name-asc").map(
  (entry) => entry.path,
);

test.describe("viewer", () => {
  test("opens on double-click, steps with arrows and buttons, closes on Escape", async ({
    page,
  }) => {
    await gotoBrowse(page, { path: "comics/alpha" });
    await expectEntryCount(page, ALPHA.length);
    await openViewer(page, "comics/alpha/1.jpg");
    await expect(viewerFor(page, "1.jpg")).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(viewerFor(page, "2.jpg")).toBeVisible();
    await page.getByRole("button", { name: "Next item" }).last().click();
    await expect(viewerFor(page, "10.jpg")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(viewerFor(page, "2.jpg")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("steps across a page boundary and wraps only when loop navigation is on", async ({
    page,
  }) => {
    await gotoBrowse(page, { path: "bulk" });
    await expectEntryCount(page, 60);
    const last = BULK[BULK.length - 1];
    const first = BULK[0];
    const sixtieth = BULK[59];
    if (!last || !first || !sixtieth) throw new Error("fixture bulk folder too small");

    await openSettings(page);
    await setSettingToggle(page, "Loop viewer navigation", false);
    await closeSettings(page);

    // Stepping forward from the last loaded item fetches the next page.
    await openViewer(page, sixtieth);
    await page.keyboard.press("ArrowRight");
    await expect(viewerFor(page, "bulk-061.png")).toBeVisible();
    await page.keyboard.press("Escape");
    await loadAllPages(page, BULK.length);

    // Without loop, the true end is a hard stop.
    await openViewer(page, last);
    await expect(page.getByRole("button", { name: "Next item" }).last()).toBeDisabled();
    await page.keyboard.press("ArrowRight");
    await expect(viewerFor(page, "bulk-070.png")).toBeVisible();
    await page.keyboard.press("Escape");

    await openSettings(page);
    await setSettingToggle(page, "Loop viewer navigation", true);
    await closeSettings(page);
    await openViewer(page, last);
    await page.keyboard.press("ArrowRight");
    await expect(viewerFor(page, "bulk-001.png")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(viewerFor(page, "bulk-070.png")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("a video resumes where it was paused when the position is remembered", async ({ page }) => {
    await gotoBrowse(page, { path: "videos" });
    await openSettings(page);
    await setSettingToggle(page, "Remember PDF page and video position", true);
    await setSettingToggle(page, "Autoplay videos", false);
    await closeSettings(page);

    const dialog = await openViewer(page, "videos/clip-a.mp4");
    const video = dialog.locator("video");
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
      .toBeGreaterThan(0);
    await video.evaluate(async (element: HTMLVideoElement) => {
      element.currentTime = 2;
      await element.play();
      await new Promise((resolve) => setTimeout(resolve, 300));
      element.pause();
    });
    const paused = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
    expect(paused).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Escape");

    const reopened = await openViewer(page, "videos/clip-a.mp4");
    const resumed = reopened.locator("video");
    await expect
      .poll(() => resumed.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThanOrEqual(1.9);
    await page.keyboard.press("Escape");
  });

  test("a PDF opens and reports its page count", async ({ page }) => {
    await gotoBrowse(page, { path: "docs" });
    const dialog = await openViewer(page, "docs/guide.pdf");
    await expect(dialog.getByText("guide.pdf · 3 pages")).toBeVisible();
    await expect(dialog.locator("[data-page-number='3']")).toBeAttached();
    await page.keyboard.press("Escape");
  });
});

test.describe("keyboard", () => {
  test("arrows move the focus through the grid and Enter opens the focused item", async ({
    page,
  }) => {
    await gotoBrowse(page, { path: "comics/alpha" });
    await expectEntryCount(page, ALPHA.length);
    await card(page, "comics/alpha/1.jpg").click();
    await expect(page.getByRole("complementary", { name: "Selected media" })).toContainText(
      "1.jpg",
    );
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(viewerFor(page, "10.jpg")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(archiveBrowser(page)).toBeVisible();
  });
});
