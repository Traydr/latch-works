import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Page-level helpers for the Pane View suite. They read the gallery the way a
 * user sees it: cards in the archive browser and the floating toolbar's buttons.
 */
export type SortLabel = "A-Z" | "Z-A" | "Newest" | "Oldest" | "Random";

export interface BrowseOptions {
  comic?: boolean;
  path?: string;
  q?: string;
  recursive?: boolean;
}

function browseUrl(options: BrowseOptions = {}): string {
  const search = new URLSearchParams();
  if (options.path) search.set("path", options.path);
  if (options.q) search.set("q", options.q);
  if (options.recursive) search.set("recursive", "true");
  if (options.comic) search.set("comic", "true");
  const query = search.toString();
  return query === "" ? "/" : `/?${query}`;
}

export function archiveBrowser(page: Page): Locator {
  return page.getByRole("region", { name: "Archive browser" });
}

export function toolbarButton(page: Page, name: "Recursive" | "Comic" | "Exclude" | "Shuffle") {
  return page.getByRole("button", { name, exact: true });
}

export async function gotoBrowse(page: Page, options: BrowseOptions = {}): Promise<void> {
  await page.goto(browseUrl(options));
  await expect(archiveBrowser(page)).toBeVisible();
}

/** Waits until exactly `count` cards are rendered (the viewport is tall enough for all). */
export async function expectEntryCount(page: Page, count: number): Promise<void> {
  await expect(archiveBrowser(page).locator("button > div[title]")).toHaveCount(count);
}

/**
 * Card paths in visual order. Cards are absolutely positioned inside the
 * browser region, so DOM order is not authoritative; sort by (top, left).
 */
export async function readCardPaths(page: Page): Promise<string[]> {
  const cards = await archiveBrowser(page)
    .locator("button > div[title]")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const card = element.parentElement;
        return {
          left: Number.parseFloat(card?.style.left ?? "0"),
          title: element.getAttribute("title") ?? "",
          top: Number.parseFloat(card?.style.top ?? "0"),
        };
      }),
    );
  cards.sort((a, b) => a.top - b.top || a.left - b.left);
  return cards.map((card) => card.title);
}

/** Presses "Load more" until `total` cards are on screen. */
export async function loadAllPages(page: Page, total: number): Promise<void> {
  const cards = archiveBrowser(page).locator("button > div[title]");
  for (let round = 0; round < 20; round += 1) {
    const before = await cards.count();
    if (before >= total) break;
    // The grid re-renders while a page lands, which can detach the button mid-click.
    await page
      .getByRole("button", { name: "Load more" })
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await expect.poll(() => cards.count()).toBeGreaterThan(before);
  }
  await expect(cards).toHaveCount(total);
}

export async function chooseSort(page: Page, label: SortLabel): Promise<void> {
  // The button's accessible name is the active sort label; its title is stable.
  await page.getByTitle("Sort", { exact: true }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
}

export function card(page: Page, path: string): Locator {
  return archiveBrowser(page).locator(`button > div[title="${path}"]`);
}

export async function openViewer(page: Page, path: string): Promise<Locator> {
  await card(page, path).dblclick();
  const dialog = page.getByRole("dialog", { name: /^Viewer for / });
  await expect(dialog).toBeVisible();
  return dialog;
}

export function viewerFor(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name: `Viewer for ${name}`, exact: true });
}

export async function openSettings(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "Settings" });
  if (await heading.isVisible()) return;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(heading).toBeVisible();
}

export async function closeSettings(page: Page): Promise<void> {
  // The close control is the full-screen backdrop behind the drawer; click a corner of it.
  await page.getByRole("button", { name: "Close settings" }).click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0);
}

export async function setSettingToggle(page: Page, label: string, on: boolean): Promise<void> {
  const toggle = page.getByLabel(label, { exact: true });
  if ((await toggle.isChecked()) !== on) {
    await toggle.click();
  }
}
