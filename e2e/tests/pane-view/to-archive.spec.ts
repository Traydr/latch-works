import { expect, type Page, test } from "@playwright/test";

/**
 * Plan 068: To archive. Each test makes its links unique to the run, so a reused e2e server (which
 * keeps its database) starts each run with none of them.
 */

function pasteBox(page: Page) {
  return page.getByPlaceholder("Paste a link");
}

function waitingRow(page: Page, text: string) {
  return page.getByRole("listitem").filter({ hasText: text });
}

async function addLinks(page: Page, text: string): Promise<void> {
  await pasteBox(page).fill(text);
  await pasteBox(page).press("Enter");
}

test.describe("To archive", () => {
  test("pasted links wait by site, duplicates are caught, and Archived moves one over", async ({
    page,
  }) => {
    const run = Date.now();
    const work = `archiveofourown.org/works/${run}`;
    const creator = `patreon.com/e2e${run}`;

    await page.goto("/");
    await page.getByRole("link", { name: "To archive" }).click();
    await expect(page).toHaveURL(/\/to-archive$/);

    // The same work written two ways counts once; the Patreon link loses its tab and tracking.
    await addLinks(
      page,
      `https://${work}/chapters/1 https://www.patreon.com/c/E2E${run}/posts?utm_source=discord https://www.${work}`,
    );
    await expect(page.getByRole("status")).toContainText("Added 2");
    await expect(waitingRow(page, work)).toHaveCount(1);
    await expect(waitingRow(page, creator)).toHaveCount(1);

    const sites = page.getByRole("navigation", { name: "Sites" });

    await sites.getByRole("button", { name: /^Patreon/ }).click();
    await expect(page).toHaveURL(/site=patreon/);
    await expect(waitingRow(page, work)).toHaveCount(0);
    await sites.getByRole("button", { name: /^All sites/ }).click();

    await waitingRow(page, work).getByRole("button", { name: "Archived" }).click();
    await expect(waitingRow(page, work)).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("Archived");

    // Pasting it again says it's done and offers to queue it again.
    await addLinks(page, `https://${work}`);
    await expect(page.getByRole("status")).toContainText("Archived today");
    await expect(
      page.getByRole("status").getByRole("button", { name: "Queue again" }),
    ).toBeVisible();

    await addLinks(page, `https://www.patreon.com/e2e${run}`);
    await expect(page.getByRole("status")).toContainText("Already waiting");

    await page
      .getByRole("navigation", { name: "Lists" })
      .getByRole("link", { name: "Archived" })
      .click();
    await expect(waitingRow(page, work)).toHaveCount(1);
    await expect(waitingRow(page, creator)).toHaveCount(0);
  });

  test("focus mode goes through a site's links with the keyboard", async ({ context, page }) => {
    const run = Date.now();
    const first = `danbooru.donmai.us/posts/${run}`;
    const second = `danbooru.donmai.us/posts/${run + 1}`;

    await page.goto("/to-archive");
    await addLinks(page, `https://${first} https://${second}?q=x`);
    await expect(page.getByRole("status")).toContainText("Added 2");

    await page
      .getByRole("navigation", { name: "Sites" })
      .getByRole("button", { name: /^Danbooru/ })
      .click();
    await page.getByRole("button", { name: "Start" }).click();

    const card = page.getByRole("article", { name: "Current link" });

    await expect(card).toContainText(first);

    // ↵ opens the link in a new tab; back here, Archived is the main button.
    const opened = context.waitForEvent("page");

    await page.keyboard.press("Enter");
    await (await opened).close();
    await expect(card).toContainText("Opened just now");

    await page.keyboard.press("l");
    await expect(card).toContainText(second);

    await page.keyboard.press("a");
    await expect(card).toContainText(first);
    await expect(page.getByRole("status")).toContainText("Archived");

    await page.keyboard.press("a");
    await expect(page.getByText("Nothing left here")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/to-archive\?site=danbooru$/);
    await expect(waitingRow(page, `posts/${run}`)).toHaveCount(0);
  });
});
