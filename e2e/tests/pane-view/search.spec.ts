import { expect, type Page, test } from "@playwright/test";
import { FIXTURE_ITEMS, sortFixtureItems } from "../../src/fixture.ts";
import { expectCardPaths, expectEntryCount, gotoBrowse } from "../../src/pane-view.ts";

async function search(page: Page, query: string): Promise<void> {
  const box = page.getByRole("searchbox", { name: "Search archive" });
  await box.fill(query);
  await box.press("Enter");
  await expect(page).toHaveURL((url) => url.searchParams.get("q") === query);
}

test.describe("search", () => {
  test("a plain query matches paths anywhere in the archive", async ({ page }) => {
    await gotoBrowse(page, { path: "docs" });
    await search(page, "photo");

    const expected = sortFixtureItems(
      FIXTURE_ITEMS.filter((entry) => entry.path.includes("photo")),
      "name-asc",
    );

    await expectEntryCount(page, expected.length);
    await expectCardPaths(
      page,
      expected.map((entry) => entry.path),
    );
  });

  test("% and _ in a query match literally, not as wildcards", async ({ page }) => {
    await gotoBrowse(page);
    await search(page, "100%_done");
    await expectEntryCount(page, 2);
    await expectCardPaths(page, ["docs/100%_done_1.png", "docs/100%_done_2.png"]);

    // A lone "%" would match everything if it were a wildcard.
    await search(page, "%");
    await expectEntryCount(page, 2);
  });

  test("an empty result shows no cards", async ({ page }) => {
    await gotoBrowse(page);
    await search(page, "no-such-file-anywhere");
    await expectEntryCount(page, 0);
  });
});
