import { expect, test } from "@playwright/test";
import {
  fixtureComics,
  fixtureItemsInScope,
  isFixtureImageLike,
  isFixtureVideo,
  sortFixtureItems,
} from "../../src/fixture.ts";
import {
  card,
  closeSettings,
  expectEntryCount,
  gotoBrowse,
  openSettings,
  readCardPaths,
  setSettingToggle,
  toolbarButton,
} from "../../src/pane-view.ts";

const MIXED = sortFixtureItems(fixtureItemsInScope("mixed", false), "name-asc");

test.describe("filters", () => {
  test.afterEach(async ({ page }) => {
    await openSettings(page);
    await setSettingToggle(page, "Show images", true);
    await setSettingToggle(page, "Show videos", true);
    await closeSettings(page);
  });

  test("hiding videos or images removes only those items and keeps the order", async ({ page }) => {
    await gotoBrowse(page, { path: "mixed" });
    await expectEntryCount(page, MIXED.length);

    await openSettings(page);
    await setSettingToggle(page, "Show videos", false);
    await closeSettings(page);
    const imagesOnly = MIXED.filter((entry) => !isFixtureVideo(entry));
    await expectEntryCount(page, imagesOnly.length);
    expect(await readCardPaths(page)).toEqual(imagesOnly.map((entry) => entry.path));

    await openSettings(page);
    await setSettingToggle(page, "Show videos", true);
    await setSettingToggle(page, "Show images", false);
    await closeSettings(page);
    const videosOnly = MIXED.filter(isFixtureVideo);
    await expectEntryCount(page, videosOnly.length);
    expect(await readCardPaths(page)).toEqual(videosOnly.map((entry) => entry.path));
  });
});

test.describe("recursive", () => {
  test("toggling recursive shows the subtree and turning it off drops comic mode too", async ({
    page,
  }) => {
    await gotoBrowse(page, { path: "comics" });
    await expectEntryCount(page, 3);

    await toolbarButton(page, "Recursive").click();
    await expect(page).toHaveURL(/recursive=true/);
    const subtree = sortFixtureItems(fixtureItemsInScope("comics", true), "name-asc");
    await expectEntryCount(page, subtree.length);
    expect(await readCardPaths(page)).toEqual(subtree.map((entry) => entry.path));

    await toolbarButton(page, "Comic").click();
    await expect(page).toHaveURL(/comic=true/);
    await expect(toolbarButton(page, "Recursive")).toHaveAttribute("aria-pressed", "true");

    await toolbarButton(page, "Recursive").click();
    await expect(page).not.toHaveURL(/recursive=true/);
    await expect(page).not.toHaveURL(/comic=true/);
    await expectEntryCount(page, 3);
  });

  test("navigating to the root forces recursive and comic off", async ({ page }) => {
    await gotoBrowse(page, { path: "comics", recursive: true, comic: true });
    await expect(toolbarButton(page, "Comic")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("list", { name: "Archive folders" }).getByTitle("Archive root").click();
    await expect(page).not.toHaveURL(/recursive|comic/);
    await expect(toolbarButton(page, "Recursive")).toBeDisabled();
  });
});

test.describe("recursive excludes", () => {
  test("excluding a child folder removes exactly its subtree, survives a reload, and is search-transparent", async ({
    page,
  }) => {
    await gotoBrowse(page, { path: "comics", recursive: true });
    const subtree = sortFixtureItems(fixtureItemsInScope("comics", true), "name-asc");
    await expectEntryCount(page, subtree.length);

    const exclude = toolbarButton(page, "Exclude");
    await expect(exclude).toBeEnabled();
    await exclude.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemcheckbox")).toHaveText([
      /alpha.*Included/,
      /beta.*Included/,
      /nested.*Included/,
    ]);
    await menu.getByRole("menuitemcheckbox", { name: /beta/ }).click();
    await expect(menu.getByRole("menuitemcheckbox", { name: /beta/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    const withoutBeta = subtree.filter((entry) => !entry.path.startsWith("comics/beta/"));
    await expectEntryCount(page, withoutBeta.length);
    expect(await readCardPaths(page)).toEqual(withoutBeta.map((entry) => entry.path));

    await page.reload();
    await expectEntryCount(page, withoutBeta.length);

    // Comic mode honours the same exclude: no beta comic.
    await toolbarButton(page, "Comic").click();
    const comics = fixtureComics("comics").filter((comic) => comic.folderPath !== "comics/beta");
    await expectEntryCount(page, comics.length);
    expect(await readCardPaths(page)).toEqual(comics.map((comic) => comic.folderPath));
    await toolbarButton(page, "Comic").click();

    // A search ignores excludes: beta's pages are still found.
    await page.getByRole("searchbox", { name: "Search archive" }).fill("page-");
    await page.getByRole("searchbox", { name: "Search archive" }).press("Enter");
    await expectEntryCount(page, 3);

    // Back in the recursive browse the exclude is still in force; clearing it restores the listing.
    await gotoBrowse(page, { path: "comics", recursive: true });
    await expectEntryCount(page, withoutBeta.length);
    await toolbarButton(page, "Exclude").click();
    await page.getByRole("menu").getByRole("menuitemcheckbox", { name: /beta/ }).click();
    await expectEntryCount(page, subtree.length);
  });
});

test.describe("comic mode", () => {
  test("leaf folders with images become comics; root media, parents and video-only folders do not", async ({
    page,
  }) => {
    await gotoBrowse(page, { path: "comics", comic: true });
    const comics = fixtureComics("comics");
    await expectEntryCount(page, comics.length);
    expect(await readCardPaths(page)).toEqual(comics.map((comic) => comic.folderPath));
    for (const comic of comics) {
      await expect(card(page, comic.folderPath)).toContainText(`${comic.pages.length} pages`);
    }
  });

  test("a mixed folder counts only its image pages; a video-only folder is never a comic", async ({
    page,
  }) => {
    await gotoBrowse(page, { path: "mixed", comic: true });
    // "mixed" is itself the leaf; comic mode from inside it finds nothing strictly below.
    await expectEntryCount(page, 0);

    await gotoBrowse(page, { path: "videos", comic: true });
    await expectEntryCount(page, 0);
  });

  test("opening a comic shows every page in natural order", async ({ page }) => {
    await gotoBrowse(page, { path: "comics", comic: true });
    const alpha = fixtureComics("comics").find((comic) => comic.folderPath === "comics/alpha");
    if (!alpha) throw new Error("fixture has no comics/alpha");
    await card(page, alpha.folderPath).dblclick();
    await expect(page.getByText(`1/${alpha.pages.length} pages`)).toBeVisible();
    const firstPage = alpha.pages[0];
    const lastPage = alpha.pages[alpha.pages.length - 1];
    if (!firstPage || !lastPage) throw new Error("comic without pages");
    const pageName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    // The detail panel also shows the cover; scope to the reader overlay. Every page is
    // rendered in reading order.
    const reader = page.locator("div.fixed.inset-0").filter({ hasText: /\/\d+ pages/ });
    await expect
      .poll(() =>
        reader
          .getByRole("img")
          .evaluateAll((images) => images.map((image) => image.getAttribute("alt"))),
      )
      .toEqual(alpha.pages.map(pageName));
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByText(/\/\d+ pages/)).toHaveCount(0);
  });

  test("searching in comic mode finds comics across the archive", async ({ page }) => {
    await gotoBrowse(page, { path: "docs", comic: true, q: "inner" });
    await expectEntryCount(page, 1);
    expect(await readCardPaths(page)).toEqual(["comics/nested/inner"]);
    expect(
      fixtureItemsInScope("comics/nested/inner", false).filter(isFixtureImageLike),
    ).toHaveLength(3);
  });
});
