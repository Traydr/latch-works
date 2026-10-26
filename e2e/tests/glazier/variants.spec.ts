import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import {
  chooseFolder,
  type GlazierSession,
  latestToast,
  launchGlazier,
  openView,
  waitForJobs,
} from "../../src/glazier.ts";
import { heldFiles } from "../../src/glazier-archive.ts";

/** A picture with soft fills, a hard edge and a stroke, different for each seed. */
function picture(seed: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${(seed * 47) % 360} 70% 40%)"/>
      <stop offset="1" stop-color="hsl(${(seed * 47 + 160) % 360} 60% 70%)"/>
    </linearGradient></defs>
    <rect width="640" height="480" fill="url(#g)"/>
    <circle cx="${120 + ((seed * 83) % 400)}" cy="${100 + ((seed * 61) % 280)}" r="${60 + (seed % 5) * 20}" fill="#fff8"/>
    <rect x="${(seed * 37) % 500}" y="300" width="140" height="${40 + (seed % 3) * 30}" fill="#0008"/>
    <path d="M0 ${200 + (seed % 7) * 20} Q 320 ${seed % 2 ? 0 : 480} 640 240" stroke="#222" stroke-width="18" fill="none"/>
  </svg>`;

  return sharp(Buffer.from(svg));
}

/** A caption box, as a translated page adds, in the top right. */
const CAPTION = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <rect x="530" y="30" width="70" height="32" rx="8" fill="#fff"/>
  <rect x="542" y="42" width="46" height="8" fill="#111"/>
</svg>`);

/** Another face: a dark shape on the left. */
const FACE = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <ellipse cx="150" cy="160" rx="30" ry="24" fill="#123"/>
</svg>`);

type Picture = ReturnType<typeof sharp>;

let archive: string;

let session: GlazierSession;

async function write(relPath: string, image: Picture): Promise<void> {
  const target = path.join(archive, ...relPath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await image.toFile(target);
}

async function variant(seed: number, overlay: Buffer | null): Promise<Picture> {
  const base = await picture(seed).png().toBuffer();

  return overlay ? sharp(base).composite([{ input: overlay }]) : sharp(base);
}

test.beforeAll(async () => {
  archive = await mkdtemp(path.join(os.tmpdir(), "oriel-variants-"));
  // One page in three versions in one folder, and another site's copies of two of them.
  await write("fanbox/101_jp.png", await variant(7, null));
  await write("fanbox/101_en.png", await variant(7, CAPTION));
  await write("fanbox/101_clean.png", await variant(7, FACE));
  await write("pixiv/900_p0.jpg", (await variant(7, null)).resize(480, 360).jpeg({ quality: 70 }));
  await write("pixiv/900_p1.png", (await variant(7, CAPTION)).png({ compressionLevel: 1 }));
  // Two outfits of another picture, and nothing else.
  await write("alt/outfit-a.png", await variant(3, null));
  await write("alt/outfit-b.png", await variant(3, FACE));
  session = await launchGlazier();
});

test.afterAll(async () => {
  await session?.app.close();
  await rm(archive, { force: true, recursive: true });
});

test("Spot variants keeps each picture once and moves sets of variants out of review", async () => {
  const { window } = session;
  const tile = (name: string) => window.locator(`[data-file-name="${name}"]`);

  await window.getByRole("button", { name: /Choose folder/i }).click();
  await chooseFolder(window, archive);
  await waitForJobs(window);
  await openView(window, "duplicates");

  // Off, the page's five files are one set that keeps one, and the outfits are another.
  await expect(window.getByRole("button", { name: /^Similar/ })).toContainText("2");
  await expect(window.getByRole("button", { name: /^Variants/ })).toHaveCount(0);

  await window.getByRole("switch", { name: "Spot variants" }).click();
  await waitForJobs(window);

  await expect(window.getByRole("button", { name: /^Similar/ })).toContainText("1");
  await expect(window.getByRole("button", { name: /^Variants/ })).toContainText("1");

  // The three versions stay, from the folder that holds all of them; the other site's go.
  await window.locator("[data-set-key]", { hasText: "101_" }).first().click();

  for (const name of ["101_jp.png", "101_en.png", "101_clean.png"]) {
    await expect(tile(name)).toHaveAttribute("data-keep", "true");
  }

  for (const name of ["900_p0.jpg", "900_p1.png"]) {
    await expect(tile(name)).toHaveAttribute("data-keep", "false");
    await expect(tile(name)).toContainText("A copy of");
  }

  await window.keyboard.press("Enter");
  await expect(latestToast(window)).toContainText("Kept 3 versions");
  await expect
    .poll(() => heldFiles(session.userDataDir, archive))
    .toEqual(["pixiv/900_p0.jpg", "pixiv/900_p1.png"]);

  // The outfits wait under Variants, every version kept, until marked as not duplicates.
  await window.getByRole("button", { name: /^Variants/ }).click();
  await expect(tile("outfit-a.png")).toHaveAttribute("data-keep", "true");
  await expect(tile("outfit-b.png")).toHaveAttribute("data-keep", "true");
  await expect(window.locator("[data-decide]")).toContainText("Not duplicates");

  await window.keyboard.press("Enter");
  await expect(latestToast(window)).toContainText("Marked as not duplicates");
  await expect(window.getByRole("button", { name: /^Not duplicates/ })).toContainText("2");
});
