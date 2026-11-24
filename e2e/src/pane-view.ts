import { expect, type Locator, type Page } from "@playwright/test";
import { PANE_VIEW_CREDENTIALS } from "./env.ts";

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

/** The gallery's cards: the browser's buttons whose tooltip names an archive path. */
function cards(page: Page): Locator {
  const browser = archiveBrowser(page);

  return browser.getByRole("button").and(browser.getByTitle(/./));
}

/** Waits until exactly `count` cards are rendered (the viewport is tall enough for all). */
export async function expectEntryCount(page: Page, count: number): Promise<void> {
  await expect(cards(page)).toHaveCount(count);
}

/** Card paths in the order they are laid out on screen: by row, then left to right. */
export async function readCardPaths(page: Page): Promise<string[]> {
  const laidOut = await cards(page).evaluateAll((elements) =>
    elements.map((element) => {
      const { left, top } = element.getBoundingClientRect();

      return { left, title: element.getAttribute("title") ?? "", top };
    }),
  );

  laidOut.sort((a, b) => a.top - b.top || a.left - b.left);

  return laidOut.map((card) => card.title);
}

/**
 * Presses "Load more" until `total` cards are on screen. A page can also load on its own, when the
 * button comes into view, so each round first waits for either.
 */
export async function loadAllPages(page: Page, total: number): Promise<void> {
  const loadMore = page.getByRole("button", { name: "Load more" });

  for (let before = await cards(page).count(); before < total; before = await cards(page).count()) {
    await expect
      .poll(async () => (await cards(page).count()) > before || (await loadMore.isVisible()))
      .toBe(true);

    if ((await cards(page).count()) === before) {
      await loadMore.click();
    }

    await expect.poll(() => cards(page).count()).toBeGreaterThan(before);
  }

  await expect(cards(page)).toHaveCount(total);
}

/**
 * The grid keeps the previous listing until the next one arrives (`keepPreviousData`), so an
 * order assertion after a sort, search or navigation has to wait for the cards to change.
 */
export async function expectCardPaths(page: Page, paths: string[]): Promise<void> {
  await expect.poll(() => readCardPaths(page)).toEqual(paths);
}

export async function chooseSort(page: Page, label: SortLabel): Promise<void> {
  // The button's accessible name is the active sort label; its title is stable.
  await page.getByTitle("Sort", { exact: true }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
}

export function card(page: Page, path: string): Locator {
  return archiveBrowser(page).getByTitle(path, { exact: true });
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

/** Better Auth's sign-in window: three sign-ins per IP, and each one restarts the window. */
const SIGN_IN_WINDOW_MS = 10_500;

/**
 * Signs in through the login form from a login page. The app reports a sign-in that Better Auth's
 * rate limit refused as wrong credentials, and specs that sign in a few seconds apart can hit that
 * limit. So a refused attempt with the right password waits the window out and tries once more.
 */
export async function signInWithForm(page: Page): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.getByLabel("Username").fill(PANE_VIEW_CREDENTIALS.username);
    await page.getByLabel("Password").fill(PANE_VIEW_CREDENTIALS.password);
    // The form posts, then the server redirects: wait for the page that redirect lands on.
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/auth/login" &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    await page.waitForURL((url) => url.pathname !== "/login" || url.searchParams.has("error"));

    if (!new URL(page.url()).searchParams.has("error")) return;

    await page.waitForTimeout(SIGN_IN_WINDOW_MS);
  }

  throw new Error("Signing in with the e2e credentials was refused twice.");
}
