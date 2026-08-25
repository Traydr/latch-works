import { expect, test } from "@playwright/test";
import {
  type FixtureSortMode,
  fixtureFolderPaths,
  fixtureItemsInScope,
  sortFixtureItems,
} from "../../src/fixture.ts";
import {
  chooseSort,
  expectEntryCount,
  gotoBrowse,
  loadAllPages,
  readCardPaths,
  type SortLabel,
  toolbarButton,
} from "../../src/pane-view.ts";

const ORDERED_MODES: { label: SortLabel; mode: FixtureSortMode }[] = [
  { label: "A-Z", mode: "name-asc" },
  { label: "Z-A", mode: "name-desc" },
  { label: "Newest", mode: "date-newest" },
  { label: "Oldest", mode: "date-oldest" },
];

/** The whole archive, recursively from a folder that holds everything but the root file. */
const SCOPE = "bulk";

test.describe("sorting and paging", () => {
  for (const { label, mode } of ORDERED_MODES) {
    test(`${label} orders a recursive subtree by the documented rules`, async ({ page }) => {
      await gotoBrowse(page, { path: "comics", recursive: true });
      await chooseSort(page, label);
      const expected = sortFixtureItems(fixtureItemsInScope("comics", true), mode).map(
        (entry) => entry.path,
      );
      // A recursive listing carries no folder entries; every card is media.
      await expectEntryCount(page, expected.length);
      expect(await readCardPaths(page)).toEqual(expected);
    });

    test(`${label} keeps folders first, then media, in a plain folder listing`, async ({
      page,
    }) => {
      await gotoBrowse(page, { path: "comics" });
      await chooseSort(page, label);
      const folders = fixtureFolderPaths().filter((folder) => /^comics\/[^/]+$/.test(folder));
      // Folders follow the name direction and ignore the date modes.
      if (mode === "name-desc") folders.reverse();
      await expectEntryCount(page, folders.length);
      expect(await readCardPaths(page)).toEqual(folders);
    });
  }

  test("a folder larger than one page loads the rest in the same order", async ({ page }) => {
    await gotoBrowse(page, { path: SCOPE });
    const expected = sortFixtureItems(fixtureItemsInScope(SCOPE, false), "name-asc").map(
      (entry) => entry.path,
    );
    expect(expected.length).toBeGreaterThan(60);
    await chooseSort(page, "A-Z");
    await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
    await expectEntryCount(page, 60);
    await loadAllPages(page, expected.length);
    expect(await readCardPaths(page)).toEqual(expected);
  });

  test("Random is a permutation, stable across reloads, and changes on Shuffle", async ({
    page,
  }) => {
    await gotoBrowse(page, { path: SCOPE });
    await chooseSort(page, "Random");
    const expected = fixtureItemsInScope(SCOPE, false).map((entry) => entry.path);
    await loadAllPages(page, expected.length);
    const first = await readCardPaths(page);
    expect([...first].sort()).toEqual([...expected].sort());
    expect(first).not.toEqual(
      sortFixtureItems(fixtureItemsInScope(SCOPE, false), "name-asc").map((entry) => entry.path),
    );

    await page.reload();
    await loadAllPages(page, expected.length);
    expect(await readCardPaths(page)).toEqual(first);

    await toolbarButton(page, "Shuffle").click();
    await expect
      .poll(async () => (await readCardPaths(page)).slice(0, 5))
      .not.toEqual(first.slice(0, 5));
    await loadAllPages(page, expected.length);
    const shuffled = await readCardPaths(page);
    expect([...shuffled].sort()).toEqual([...expected].sort());
    expect(shuffled).not.toEqual(first);
  });

  test("the sort choice survives navigating between folders", async ({ page }) => {
    await gotoBrowse(page, { path: "comics/alpha" });
    await chooseSort(page, "Z-A");
    await gotoBrowse(page, { path: "unicode" });
    const expected = sortFixtureItems(fixtureItemsInScope("unicode", false), "name-desc");
    await expectEntryCount(page, expected.length);
    expect(await readCardPaths(page)).toEqual(expected.map((entry) => entry.path));
  });
});
