import { expect, test } from "@playwright/test";
import { fixtureFolderPaths, fixtureItemsInScope, sortFixtureItems } from "../../src/fixture.ts";
import {
  archiveBrowser,
  card,
  expectCardPaths,
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
    await expectCardPaths(page, ["comics/alpha", "comics/beta", "comics/nested"]);

    await card(page, "comics/alpha").dblclick();
    await expect(page).toHaveURL(/path=comics%2Falpha/);
    const alpha = sortFixtureItems(fixtureItemsInScope("comics/alpha", false), "name-asc");
    await expectEntryCount(page, alpha.length);
    await expectCardPaths(
      page,
      alpha.map((entry) => entry.path),
    );
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

  const parentFolderCases = [
    {
      name: "a nested image in recursive browsing",
      browse: { path: "comics", recursive: true },
      mediaPath: "comics/nested/inner/inner-1.png",
      parentPath: "comics/nested/inner",
    },
    {
      name: "a video in search results",
      browse: { q: "clip-a" },
      mediaPath: "videos/clip-a.mp4",
      parentPath: "videos",
    },
    {
      name: "a PDF in search results",
      browse: { q: "guide.pdf" },
      mediaPath: "docs/guide.pdf",
      parentPath: "docs",
    },
    {
      name: "root media in search results",
      browse: { q: "root-image" },
      mediaPath: "root-image.png",
      parentPath: "",
    },
  ];

  for (const scenario of parentFolderCases) {
    test(`the details panel opens the parent folder of ${scenario.name}`, async ({ page }) => {
      await gotoBrowse(page, scenario.browse);
      await card(page, scenario.mediaPath).click();
      const details = page.getByRole("complementary", { name: "Selected media" });
      await expect(details).toContainText(scenario.mediaPath);
      await details.getByRole("button", { name: "Open parent folder" }).click();

      await expect
        .poll(() => new URL(page.url()).searchParams.get("path") ?? "")
        .toBe(scenario.parentPath);
      await expect(page).not.toHaveURL(/[?&]q=/);
      const folders = page.getByRole("list", { name: "Archive folders" });

      await expect(
        folders.getByTitle(scenario.parentPath || "Archive root", { exact: true }),
      ).toHaveAttribute("data-active", "true");

      const children = fixtureFolderPaths().filter(
        (path) => path.slice(0, Math.max(0, path.lastIndexOf("/"))) === scenario.parentPath,
      );

      const media = sortFixtureItems(fixtureItemsInScope(scenario.parentPath, false), "name-asc");

      await expectCardPaths(page, [...children, ...media.map((item) => item.path)]);
    });
  }

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
