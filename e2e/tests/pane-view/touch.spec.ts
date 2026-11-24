import { expect, type Page, test } from "@playwright/test";
import { card, gotoBrowse } from "../../src/pane-view.ts";

/**
 * Plan 066: Pane View on a phone. Chromium reports no safe-area insets, so each test stands in an
 * iPhone's through the `--safe-area-*` properties the layout reads instead of env().
 */

/** Apple's minimum tap target, in CSS pixels. */
const MIN_TARGET = 44;

interface SafeAreaInsets {
  bottom: number;
  left: number;
  right: number;
}

async function standInSafeArea(page: Page, insets: SafeAreaInsets): Promise<void> {
  await page.addStyleTag({
    content: `:root {
      --safe-area-bottom: ${insets.bottom}px;
      --safe-area-left: ${insets.left}px;
      --safe-area-right: ${insets.right}px;
    }`,
  });
}

interface ButtonBox {
  bottom: number;
  hitHeight: number;
  hitWidth: number;
  label: string;
  left: number;
  right: number;
}

/** Every button on screen: its box, and its tap target including a `touch-target` pseudo-box. */
async function expectTapTargets(page: Page): Promise<void> {
  const buttons = await readVisibleButtons(page);
  expect(buttons.length).toBeGreaterThan(2);

  for (const button of buttons) {
    expect.soft(button.hitWidth, `${button.label} tap width`).toBeGreaterThanOrEqual(MIN_TARGET);
    expect.soft(button.hitHeight, `${button.label} tap height`).toBeGreaterThanOrEqual(MIN_TARGET);
  }
}

async function readVisibleButtons(page: Page): Promise<ButtonBox[]> {
  return page.locator("button:visible").evaluateAll((buttons) =>
    buttons.flatMap((button) => {
      const rect = button.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) return [];

      const after = getComputedStyle(button, "::after");
      const pseudo = after.content !== "none" && after.position === "absolute";

      return [
        {
          bottom: rect.bottom,
          hitHeight: Math.max(rect.height, pseudo ? Number.parseFloat(after.height) : 0),
          hitWidth: Math.max(rect.width, pseudo ? Number.parseFloat(after.width) : 0),
          label: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
          left: rect.left,
          right: rect.right,
        },
      ];
    }),
  );
}

test.describe("touch", () => {
  test.describe("iPhone in portrait", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { height: 852, width: 393 } });

    test("the toolbar clears the home indicator and every button is 44 px to tap", async ({
      page,
    }) => {
      await gotoBrowse(page, { path: "mixed" });
      await standInSafeArea(page, { bottom: 34, left: 0, right: 0 });

      // The toolbar sits 20 px above the home indicator's inset.
      const toolbar = page.locator("[data-floating-toolbar]");
      await expect
        .poll(async () => {
          const box = await toolbar.boundingBox();

          return box === null ? null : Math.round(box.y + box.height);
        })
        .toBe(852 - 34 - 20);

      await expectTapTargets(page);
    });

    for (const path of ["mixed/photo-1.jpg", "mixed/reel.mp4"]) {
      test(`the viewer's controls for ${path} are 44 px to tap`, async ({ page }) => {
        await gotoBrowse(page, { path: "mixed" });
        await card(page, path).tap();
        await expect(page.getByRole("dialog", { name: /^Viewer for / })).toBeVisible();
        await expectTapTargets(page);
      });
    }

    test("a tile shows its name without a hover", async ({ page }) => {
      await gotoBrowse(page, { path: "mixed" });
      // The strip that a mouse reveals on hover: the name's paragraph sits two levels inside it.
      const strip = page.getByText("photo-1.jpg", { exact: true }).locator("xpath=../..");
      await expect(strip).toHaveCSS("opacity", "1");
    });
  });

  test.describe("iPhone in landscape", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { height: 393, width: 852 } });

    test("nothing sits under the notch side", async ({ page }) => {
      await gotoBrowse(page, { path: "mixed" });
      await standInSafeArea(page, { bottom: 21, left: 59, right: 59 });

      await expect
        .poll(async () => {
          const buttons = await readVisibleButtons(page);

          return buttons
            .filter((button) => button.left < 59 || button.right > 852 - 59)
            .map((button) => button.label);
        })
        .toEqual([]);
    });
  });
});
