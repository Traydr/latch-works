import { expect, type Page, type Response, test } from "@playwright/test";
import {
  archiveBrowser,
  card,
  gotoBrowse,
  openViewer,
  signInWithForm,
} from "../../src/pane-view.ts";

/**
 * Plan 066, phase 4: the service worker. It may serve the app's hashed assets and public files,
 * and must never serve the API, server functions, media or anything that carries the session.
 */

/** Waits until a worker controls the page, so later requests can go through it. */
async function waitForWorkerControl(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

test.describe("service worker", () => {
  test("registers for this build and is served fresh, for the whole site", async ({
    page,
    request,
  }) => {
    await gotoBrowse(page);
    await waitForWorkerControl(page);

    const scriptUrl = await page.evaluate(
      () => navigator.serviceWorker.controller?.scriptURL ?? "",
    );

    expect(new URL(scriptUrl).pathname).toBe("/sw.js");
    expect(new URL(scriptUrl).searchParams.get("v")).toMatch(/.+/);

    const script = await request.get(scriptUrl);
    expect(script.status()).toBe(200);
    expect(script.headers()["cache-control"]).toBe("no-cache");
    expect(script.headers()["service-worker-allowed"]).toBe("/");
  });

  test("serves assets from its cache, but never the API, server functions or media", async ({
    page,
  }) => {
    await gotoBrowse(page);
    await waitForWorkerControl(page);

    const responses: Response[] = [];
    page.on("response", (response) => responses.push(response));

    // A controlled load: its assets come from the worker, its data and media never do.
    await gotoBrowse(page, { path: "mixed" });
    await openViewer(page, "mixed/photo-1.jpg");
    await expect(card(page, "mixed/photo-1.jpg")).toBeAttached();
    await page.evaluate(() => fetch("/api/health"));

    const origin = new URL(page.url()).origin;

    const kinds = responses.map((response) => {
      const url = new URL(response.url());
      let kind = "other";

      if (url.origin !== origin) kind = "media";
      else if (url.pathname.startsWith("/assets/")) kind = "asset";
      else if (url.pathname.startsWith("/api/")) kind = "api";
      else if (url.pathname.startsWith("/_serverFn/")) kind = "serverFn";

      return { fromWorker: response.fromServiceWorker(), kind, url: url.href };
    });

    // Each kind was requested, so the checks below are about real traffic.
    for (const kind of ["asset", "api", "serverFn", "media"]) {
      expect(
        kinds.some((entry) => entry.kind === kind),
        kind,
      ).toBe(true);
    }

    expect(kinds.some((entry) => entry.kind === "asset" && entry.fromWorker)).toBe(true);

    const privateKinds = new Set(["api", "media", "serverFn"]);

    expect(
      kinds.flatMap((entry) =>
        privateKinds.has(entry.kind) && entry.fromWorker ? [entry.url] : [],
      ),
    ).toEqual([]);

    // D1: whatever passed through the worker, its caches hold only hashed assets and public files.
    const publicFiles = [
      "/offline.html",
      "/manifest.webmanifest",
      "/favicon.svg",
      "/favicon.ico",
      "/apple-touch-icon.png",
      "/icon-192.png",
      "/icon-512.png",
    ];

    const cachedPaths = await page.evaluate(async () => {
      const paths: string[] = [];

      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) {
          paths.push(new URL(request.url).pathname);
        }
      }

      return paths;
    });

    expect(cachedPaths.length).toBeGreaterThan(0);
    expect(
      cachedPaths.filter((path) => !path.startsWith("/assets/") && !publicFiles.includes(path)),
    ).toEqual([]);
  });

  test("offers a reload when a new build's worker waits, and takes over only then", async ({
    page,
  }) => {
    await gotoBrowse(page);
    await waitForWorkerControl(page);
    const toast = page.getByRole("status").filter({ hasText: "Update available" });
    await expect(toast).toHaveCount(0);

    // What a deploy does: the page registers the worker under a new build's URL.
    await page.evaluate(() => navigator.serviceWorker.register("/sw.js?v=next-build"));
    await expect(toast).toBeVisible();
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""),
    ).not.toContain("v=next-build");

    await Promise.all([
      page.waitForEvent("load"),
      toast.getByRole("button", { name: "Reload" }).click(),
    ]);
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""))
      .toContain("v=next-build");
  });

  test("shows the offline page with no connection, and Retry brings the app back", async ({
    context,
    page,
  }) => {
    await gotoBrowse(page, { path: "mixed" });
    await waitForWorkerControl(page);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
    // The logo comes from the worker's cache too: the connection is off.
    await expect
      .poll(() => page.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);

    await context.setOffline(false);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(archiveBrowser(page)).toBeVisible();
    await expect(card(page, "mixed/photo-1.jpg")).toBeVisible();
  });
});

test.describe("signing out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // The login page reloads the public assets, which the worker caches again; a cache only this
  // test writes shows whether the caches were cleared.
  test("clears every cache the app holds", async ({ page }) => {
    await page.goto("/login");
    await signInWithForm(page);
    await expect(archiveBrowser(page)).toBeVisible();
    await waitForWorkerControl(page);
    await page.evaluate(async () => {
      const marker = await caches.open("pane-view-marker");
      await marker.put("/marker", new Response("written before signing out"));
    });

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => caches.keys())).not.toContain("pane-view-marker");

    // The offline page went with the caches; loading the login page put it back.
    await expect
      .poll(() => page.evaluate(async () => (await caches.match("/offline.html")) !== undefined))
      .toBe(true);
    await page.context().setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
    await page.context().setOffline(false);
  });
});
