import path from "node:path";
import { expect, test } from "@playwright/test";
import { FIXTURE_ARCHIVE_DIR } from "../../src/env.ts";
import {
  FIXTURE_ITEMS,
  type FixtureSortMode,
  fixtureComics,
  fixtureFolderPaths,
  fixtureItemsInScope,
  sortFixtureItems,
} from "../../src/fixture.ts";
import {
  chooseSort,
  closeSettings,
  expectPill,
  expectTileCount,
  type FrameSortLabel,
  type FrameViewSession,
  launchFrameView,
  openFolder,
  openSettingsTab,
  readTileKeys,
  setToggle,
  tileFor,
  tiles,
  waitForScan,
} from "../../src/frame-view.ts";

/** Frame View keys gallery items by absolute path. */
const absolute = (archivePath: string) => path.join(FIXTURE_ARCHIVE_DIR, ...archivePath.split("/"));

/** Frame View indexes images and videos only; the fixture's PDF is invisible to it. */
const FRAME_ITEMS = FIXTURE_ITEMS.filter((entry) => entry.kind !== "pdf");

let session: FrameViewSession;

test.beforeEach(async () => {
  session = await launchFrameView();
});

test.afterEach(async () => {
  await session.app.close();
});

test.describe("scan", () => {
  test("opens a folder, lists its children, and recurses on demand", async () => {
    const { window } = session;
    await openFolder(session, FIXTURE_ARCHIVE_DIR);
    const topLevel = fixtureFolderPaths().filter((folder) => !folder.includes("/"));
    await expectPill(window, `${topLevel.length} folders`);
    await expectPill(window, "1 items");
    await expectTileCount(window, topLevel.length + 1);

    await window.getByRole("button", { name: "Recursive", exact: true }).click();
    await waitForScan(window);
    await expectPill(window, `${FRAME_ITEMS.length} items`);
    await expectTileCount(window, FRAME_ITEMS.length);
  });

  test("excluding a root child drops its subtree from the recursive scan", async () => {
    const { window } = session;
    await openFolder(session, FIXTURE_ARCHIVE_DIR);
    await window.getByRole("button", { name: "Recursive", exact: true }).click();
    await waitForScan(window);
    await expectPill(window, `${FRAME_ITEMS.length} items`);

    await window.getByRole("button", { name: "Folders", exact: true }).click();
    const bulkCard = window.locator("[title='" + absolute("bulk") + "']");
    await bulkCard.getByRole("button", { name: "Included" }).click();
    await expect(bulkCard.getByRole("button", { name: "Excluded" })).toBeVisible();
    await window.getByRole("button", { name: "Close folder browser" }).click({
      position: { x: 4, y: 4 },
    });
    await waitForScan(window);
    const withoutBulk = FRAME_ITEMS.filter((entry) => !entry.path.startsWith("bulk/"));
    await expectPill(window, `${withoutBulk.length} items`);
  });

  test("filters hide videos and images", async () => {
    const { window } = session;
    await openFolder(session, absolute("mixed"));
    const mixed = fixtureItemsInScope("mixed", false);
    await expectTileCount(window, mixed.length);

    await openSettingsTab(window, "Usability");
    await setToggle(window, "Show videos", false);
    await closeSettings(window);
    await waitForScan(window);
    await expectTileCount(window, mixed.filter((entry) => entry.kind !== "video").length);
  });
});

test.describe("sorting", () => {
  test("a fresh scan lands in the configured sort order", async () => {
    // Fails today (plan 056, PR 3 record): after a scan the grid shows discovery order until
    // the sort is chosen again. Red until the bug is fixed; that is the point.
    const { window } = session;
    await openFolder(session, absolute("comics/alpha"));
    const expected = sortFixtureItems(fixtureItemsInScope("comics/alpha", false), "name-asc").map(
      (entry) => absolute(entry.path),
    );
    await expectTileCount(window, expected.length);
    expect(await readTileKeys(window)).toEqual(expected);
  });

  const modes: { label: FrameSortLabel; mode: FixtureSortMode }[] = [
    { label: "A-Z", mode: "name-asc" },
    { label: "Z-A", mode: "name-desc" },
    { label: "Newest", mode: "date-newest" },
    { label: "Oldest", mode: "date-oldest" },
  ];
  for (const { label, mode } of modes) {
    test(`${label} matches the shared ordering rules`, async () => {
      const { window } = session;
      await openFolder(session, absolute("comics/alpha"));
      await chooseSort(window, label);
      const expected = sortFixtureItems(fixtureItemsInScope("comics/alpha", false), mode).map(
        (entry) => absolute(entry.path),
      );
      await expectTileCount(window, expected.length);
      await expect.poll(() => readTileKeys(window)).toEqual(expected);
    });
  }

  test("Random is a permutation and Shuffle changes it", async () => {
    const { window } = session;
    await openFolder(session, absolute("bulk"));
    const expected = fixtureItemsInScope("bulk", false).map((entry) => absolute(entry.path));
    await chooseSort(window, "Random");
    await expectTileCount(window, expected.length);
    const first = await readTileKeys(window);
    expect([...first].sort()).toEqual([...expected].sort());
    await window.getByRole("button", { name: "Shuffle", exact: true }).click();
    await expect.poll(() => readTileKeys(window)).not.toEqual(first);
  });
});

test.describe("thumbnails and viewer", () => {
  test("every image tile renders a thumbnail", async () => {
    const { window } = session;
    await openFolder(session, absolute("comics/alpha"));
    const images = tiles(window).getByRole("img");
    await expect(images).toHaveCount(5);
    await expect
      .poll(
        () =>
          images.evaluateAll((elements) =>
            elements.every((image) => image instanceof HTMLImageElement && image.naturalWidth > 0),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test("double-click opens the viewer; arrows step; Escape closes", async () => {
    const { window } = session;
    await openFolder(session, absolute("comics/alpha"));
    // The viewer walks the grid in the order the grid shows (whatever that is today).
    const order = (await readTileKeys(window)).map((key) => path.basename(key));
    const [first, second, third] = order;
    if (!first || !second || !third) throw new Error("comics/alpha has fewer than 3 items");
    await tileFor(window, first).dblclick();
    await expect(window.getByRole("dialog", { name: `Viewer for ${first}` })).toBeVisible();
    await expect(window.getByRole("button", { name: "Next item" })).toBeVisible();
    await window.keyboard.press("ArrowRight");
    await expect(window.getByRole("dialog", { name: `Viewer for ${second}` })).toBeVisible();
    await window.getByRole("button", { name: "Next item" }).click();
    await expect(window.getByRole("dialog", { name: `Viewer for ${third}` })).toBeVisible();
    await window.keyboard.press("ArrowLeft");
    await expect(window.getByRole("dialog", { name: `Viewer for ${second}` })).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByRole("dialog")).toHaveCount(0);
  });

  test("comic mode groups leaf folders and the reader opens one", async () => {
    const { window } = session;
    await openFolder(session, absolute("comics"));
    await window.getByRole("button", { name: "Comic", exact: true }).click();
    await waitForScan(window);
    const comics = fixtureComics("comics");
    await expectPill(window, `${comics.length} comics`);
    await expect
      .poll(() => readTileKeys(window))
      .toEqual(comics.map((comic) => absolute(comic.folderPath)));
    await tileFor(window, "alpha").dblclick();
    await expect(window.getByRole("dialog", { name: "Comic reader for alpha" })).toBeVisible();
    await window.getByRole("button", { name: "Close", exact: true }).click();
    await expect(window.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("persistence", () => {
  test("a relaunch restores the remembered folder", async () => {
    const { window, userDataDir } = session;
    await openFolder(session, absolute("unicode"));
    await expectTileCount(window, 2);
    await session.app.close();

    session = await launchFrameView(userDataDir);
    await waitForScan(session.window);
    await expectTileCount(session.window, 2);
    expect((await readTileKeys(session.window)).sort()).toEqual(
      fixtureItemsInScope("unicode", false)
        .map((entry) => absolute(entry.path))
        .sort(),
    );
  });
});
