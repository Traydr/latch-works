import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { closeSettings, gotoBrowse, openSettings } from "../../src/pane-view.ts";

/** Plan 066: what iOS reads when Pane View is added to the Home Screen. */

const LIGHT_BACKGROUND = "#ffffff";
const DARK_BACKGROUND = "#09090b";

/** The members of the manifest these checks read; anything else passes through untouched. */
const WebAppManifestSchema = z.object({
  display: z.string(),
  icons: z.array(z.object({ sizes: z.string(), src: z.string(), type: z.string() })),
  name: z.string(),
  scope: z.string(),
  short_name: z.string(),
  start_url: z.string(),
});

async function readThemeColors(page: Page): Promise<Array<{ content: string; media: string }>> {
  return page.locator('meta[name="theme-color"]').evaluateAll((metas) =>
    metas.map((meta) => ({
      content: meta.getAttribute("content") ?? "",
      media: meta.getAttribute("media") ?? "",
    })),
  );
}

test.describe("install", () => {
  test("the manifest is linked, served as a manifest, and its icons resolve", async ({
    baseURL,
    page,
    playwright,
  }) => {
    // iOS fetches the manifest and icons with no session, so these requests carry none either.
    const request = await playwright.request.newContext({ baseURL });
    await page.goto("/login");
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBe("/manifest.webmanifest");

    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/manifest+json");

    const manifest = WebAppManifestSchema.parse(await response.json());
    expect(manifest).toMatchObject({
      display: "standalone",
      name: "Pane View",
      scope: "/",
      short_name: "Pane",
      start_url: "/",
    });
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512", "any"]);

    for (const icon of manifest.icons) {
      const iconResponse = await request.get(icon.src);
      expect(iconResponse.status(), icon.src).toBe(200);
      expect(iconResponse.headers()["content-type"], icon.src).toContain(icon.type);
    }

    const head = page.locator("head");
    await expect(head.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
      "content",
      "Pane",
    );
    await expect(
      head.locator('meta[name="apple-mobile-web-app-status-bar-style"]'),
    ).toHaveAttribute("content", "default");
    await request.dispose();
  });

  test("the theme-color metas follow the system scheme, then a manual theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await gotoBrowse(page);

    expect(await readThemeColors(page)).toEqual([
      { content: LIGHT_BACKGROUND, media: "(prefers-color-scheme: light)" },
      { content: DARK_BACKGROUND, media: "(prefers-color-scheme: dark)" },
    ]);

    await openSettings(page);
    await page.getByLabel("Theme").selectOption("dark");
    await closeSettings(page);

    // The system is still light, so the light meta is the one iOS reads: it must turn dark too.
    await expect
      .poll(() => readThemeColors(page))
      .toEqual([
        { content: DARK_BACKGROUND, media: "(prefers-color-scheme: light)" },
        { content: DARK_BACKGROUND, media: "(prefers-color-scheme: dark)" },
      ]);

    // A reload renders the authored metas again; the stored theme must win over them.
    await page.reload();
    await expect
      .poll(async () => (await readThemeColors(page)).map((meta) => meta.content))
      .toEqual([DARK_BACKGROUND, DARK_BACKGROUND]);

    // Back on System, each meta returns to its own scheme's colour.
    await openSettings(page);
    await page.getByLabel("Theme").selectOption("system");
    await closeSettings(page);
    await expect
      .poll(() => readThemeColors(page))
      .toEqual([
        { content: LIGHT_BACKGROUND, media: "(prefers-color-scheme: light)" },
        { content: DARK_BACKGROUND, media: "(prefers-color-scheme: dark)" },
      ]);
  });
});
