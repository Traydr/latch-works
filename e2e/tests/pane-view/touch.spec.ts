import { expect, type Locator, type Page, test } from "@playwright/test";
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

/** What a thumb can operate: a tap that lands on one of these did something. */
const CONTROL_SELECTOR =
  "button, a[href], input, select, textarea, [role=button], [role=slider], [role=switch]";

/**
 * Taps each enabled button in `scope` where a thumb would: its centre, which must reach the
 * button, and the middle of each edge of a 44 × 44 box around it (or its own box, if larger).
 * Those edge taps must reach the button too, unless they land on another control: two small
 * controls a few pixels apart cannot both own the gap between them, but a large control under the
 * point does not excuse it. The result lists the misses, such as a tap box clipped by its own
 * `overflow: hidden`.
 */
async function findMissedTaps(scope: Locator): Promise<string[]> {
  return scope.locator("button:visible:enabled").evaluateAll(
    (buttons, { controlSelector, minTarget }) => {
      const misses: string[] = [];

      for (const button of buttons) {
        const rect = button.getBoundingClientRect();

        if (rect.width === 0 || rect.height === 0) continue;

        const label = button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "";
        const halfWidth = Math.max(rect.width, minTarget) / 2 - 1;
        const halfHeight = Math.max(rect.height, minTarget) / 2 - 1;
        const centreX = rect.left + rect.width / 2;
        const centreY = rect.top + rect.height / 2;

        const taps: Array<[dx: number, dy: number]> = [
          [0, 0],
          [-halfWidth, 0],
          [halfWidth, 0],
          [0, -halfHeight],
          [0, halfHeight],
        ];

        for (const [dx, dy] of taps) {
          const x = centreX + dx;
          const y = centreY + dy;

          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;

          const hit = document.elementFromPoint(x, y);

          if (hit !== null && button.contains(hit)) continue;

          const onCentre = dx === 0 && dy === 0;
          const neighbour = hit?.closest(controlSelector);

          // A control packed beside this one (in the same group: a shared parent or grandparent)
          // may own the point if it lies inside that control's own tap box. A control from
          // elsewhere under the point (a tile, the viewer's step zones) excuses nothing.
          if (!onCentre && neighbour) {
            const group = button.parentElement?.parentElement;
            const packed = group?.contains(neighbour) ?? false;
            const box = neighbour.getBoundingClientRect();

            const insideItsTapBox =
              Math.abs(x - (box.left + box.width / 2)) <= Math.max(box.width, minTarget) / 2 &&
              Math.abs(y - (box.top + box.height / 2)) <= Math.max(box.height, minTarget) / 2;

            if (packed && insideItsTapBox) continue;
          }

          misses.push(
            `${label} at (${Math.round(dx)}, ${Math.round(dy)}) reached ${hit?.tagName ?? "nothing"}`,
          );
        }
      }

      return misses;
    },
    { controlSelector: CONTROL_SELECTOR, minTarget: MIN_TARGET },
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

      expect(await findMissedTaps(page.locator("body"))).toEqual([]);
    });

    test("the sidebar sheet's rows are 44 px to tap", async ({ page }) => {
      await gotoBrowse(page, { path: "mixed" });
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      const sidebar = page.getByRole("dialog", { name: "Sidebar" });
      await expect(sidebar).toBeVisible();
      expect(await findMissedTaps(sidebar)).toEqual([]);
    });

    test("the toolbar's menu items are 44 px to tap", async ({ page }) => {
      await gotoBrowse(page, { path: "mixed" });
      await page.locator("[data-floating-toolbar]").getByTitle("Sort", { exact: true }).click();
      const sortMenu = page.getByRole("menu");
      await expect(sortMenu).toBeVisible();
      expect(await findMissedTaps(sortMenu)).toEqual([]);
    });

    for (const path of ["mixed/photo-1.jpg", "mixed/reel.mp4"]) {
      test(`the viewer's controls for ${path} are 44 px to tap`, async ({ page }) => {
        await gotoBrowse(page, { path: "mixed" });
        await card(page, path).tap();
        const viewer = page.getByRole("dialog", { name: /^Viewer for / });
        await expect(viewer).toBeVisible();
        expect(await findMissedTaps(viewer)).toEqual([]);
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

      // Every control, every tile and the grid itself stay between the two insets.
      const underInsets = async () =>
        page.locator("button:visible, section[aria-label='Archive browser']").evaluateAll(
          (elements, inset) =>
            elements.flatMap((element) => {
              const { left, right, width } = element.getBoundingClientRect();
              const outside = width > 0 && (left < inset || right > window.innerWidth - inset);

              return outside ? [element.getAttribute("aria-label") ?? element.tagName] : [];
            }),
          59,
        );

      await expect.poll(underInsets).toEqual([]);
    });
  });
});
