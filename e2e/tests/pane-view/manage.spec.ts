import { expect, test } from "@playwright/test";
import { z } from "zod";
import { PANE_VIEW_CREDENTIALS } from "../../src/env.ts";
import { FIXTURE_ITEMS, fixtureComics, fixtureFolderPaths } from "../../src/fixture.ts";
import { expectEntryCount, gotoBrowse, readCardPaths } from "../../src/pane-view.ts";

const SyncRunSchema = z.object({ syncRunId: z.string() });
const EMPTY_COUNTS = { delete: 0, keep: 0, update: 0, upload: 0 };

test.describe("sync guards", () => {
  test("a wrong sync token is refused and creates no run", async ({ request }) => {
    const response = await request.post("/api/sync/runs", {
      data: { counts: EMPTY_COUNTS, sourceRoot: "e2e" },
      headers: { Authorization: "Bearer not-the-token" },
    });

    expect(response.status()).toBe(401);

    const missing = await request.post("/api/sync/runs", {
      data: { counts: EMPTY_COUNTS, sourceRoot: "e2e" },
    });

    expect(missing.status()).toBe(401);
  });

  test("an active sync run blocks destructive maintenance until it is stopped", async ({
    page,
    request,
  }) => {
    const started = await request.post("/api/sync/runs", {
      data: { counts: EMPTY_COUNTS, sourceRoot: "e2e-guard" },
      headers: { Authorization: `Bearer ${PANE_VIEW_CREDENTIALS.syncToken}` },
    });

    expect(started.ok()).toBe(true);
    SyncRunSchema.parse(await started.json());

    await page.goto("/manage");
    await expect(page.getByText("Destructive actions are disabled")).toBeVisible();
    await page.getByRole("button", { name: "Sync run history" }).click();
    await page.getByRole("button", { name: "Stop all running" }).click();
    await expect(page.getByText("Destructive actions are disabled")).toHaveCount(0);
  });
});

test.describe("stats", () => {
  test("the stats page reports the active entry count", async ({ page }) => {
    await page.goto("/stats");
    await expect(page.getByRole("heading", { name: "Archive stats" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Active entries", exact: true })).toContainText(
      String(FIXTURE_ITEMS.length),
    );
    await expect(page.getByRole("region", { name: "Folders", exact: true })).toContainText(
      String(fixtureFolderPaths().length),
    );
  });
});

test.describe("folder delete", () => {
  test("soft-deleting a folder removes it from browse and comic mode and schedules a purge", async ({
    page,
  }) => {
    // Runs last: it mutates the seeded library. "disposable" exists for this test alone.
    await page.goto("/manage");
    await page.getByRole("button", { name: "Load folders" }).click();
    await page.getByPlaceholder("Search folders").fill("disposable");
    await page.getByRole("checkbox").first().check();

    const confirmation = page.waitForEvent("dialog");
    await page.getByRole("button", { name: "Delete selected folders" }).click();
    const dialog = await confirmation;
    expect(dialog.message()).toContain("Delete 1 folder and the 2 items inside?");
    await dialog.accept();
    // The picker reloads once the delete lands.
    await expect(page.getByText("No folders match this search.")).toBeVisible();

    await gotoBrowse(page);
    const topLevel = fixtureFolderPaths().filter((folder) => !folder.includes("/"));
    const rootMedia = FIXTURE_ITEMS.filter((entry) => !entry.path.includes("/"));
    await expectEntryCount(page, topLevel.length - 1 + rootMedia.length);
    expect(await readCardPaths(page)).not.toContain("disposable");

    await gotoBrowse(page, { path: "comics", comic: true });
    await expectEntryCount(page, fixtureComics("comics").length);

    await page.goto("/manage");
    await expect(page.getByRole("button", { name: /Permanently delete \d+ items/ })).toContainText(
      "Permanently delete 2 items",
    );
  });
});
