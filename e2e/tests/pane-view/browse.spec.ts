import { expect, test } from "@playwright/test";
import { fixtureFolderPaths, fixtureItemsInScope, sortFixtureItems } from "../../src/fixture.ts";
import {
  archiveBrowser,
  card,
  expectEntryCount,
  gotoBrowse,
  readCardPaths,
  toolbarButton,
} from "../../src/pane-view.ts";

test.describe("browse", () => {
  test("the root lists its folders and root media, nothing deeper", async ({ page }) => {
    await gotoBrowse(page);
    const topLevelFolders = fixtureFolderPaths().filter((folder) => !folder.includes("/"));
    const rootMedia = fixtureItemsInScope("", false);
    await expectEntryCount(page, topLevelFolders.length + rootMedia.length);

    const paths = await readCardPaths(page);
    expect(paths).toEqual([...topLevelFolders, ...rootMedia.map((entry) => entry.path)]);
    // Recursive and comic are root-disabled.
    await expect(toolbarButton(page, "Recursive")).toBeDisabled();
    await expect(toolbarButton(page, "Comic")).toBeDisabled();
  });

  test("entering a folder shows its direct children only", async ({ page }) => {
    await gotoBrowse(page);
    await card(page, "comics").dblclick();
    await expect(page).toHaveURL(/path=comics/);
    await expectEntryCount(page, 3);
    expect(await readCardPaths(page)).toEqual(["comics/alpha", "comics/beta", "comics/nested"]);

    await card(page, "comics/alpha").dblclick();
    await expect(page).toHaveURL(/path=comics%2Falpha/);
    const alpha = sortFixtureItems(fixtureItemsInScope("comics/alpha", false), "name-asc");
    await expectEntryCount(page, alpha.length);
    expect(await readCardPaths(page)).toEqual(alpha.map((entry) => entry.path));
  });

  test("the sidebar navigates between folders", async ({ page }) => {
    await gotoBrowse(page, { path: "comics/alpha" });
    const folders = page.getByRole("list", { name: "Archive folders" });
    await folders.getByTitle("comics", { exact: true }).click();
    await expect(page).toHaveURL(/path=comics(?!%2F)/);
    await folders.getByTitle("Archive root").click();
    await expect(page).not.toHaveURL(/path=/);
    await expect(archiveBrowser(page)).toBeVisible();
  });

  test("prev and next step through the sibling folders, wrapping at the ends", async ({ page }) => {
    // comics has three children: alpha, beta, nested (natural name order).
    const nextFolder = page.getByRole("button", { name: "Next folder", exact: true });
    const prevFolder = page.getByRole("button", { name: "Prev folder", exact: true });
    const settled = async (path: string, entryCount: number) => {
      await expect(page).toHaveURL(new RegExp(`path=${encodeURIComponent(path)}(?!%2F)`));
      await expectEntryCount(page, entryCount);
      await expect(nextFolder).toBeEnabled();
    };

    await gotoBrowse(page, { path: "comics/alpha" });
    await settled("comics/alpha", 5);
    await nextFolder.click();
    await settled("comics/beta", 4);
    await nextFolder.click();
    await settled("comics/nested", 1);
    await nextFolder.click();
    await settled("comics/alpha", 5);
    await prevFolder.click();
    await settled("comics/nested", 1);

    await page.keyboard.press("Shift+A");
    await settled("comics/beta", 4);
    await page.keyboard.press("Shift+D");
    await settled("comics/nested", 1);
  });
});
