// @vitest-environment jsdom
/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectPixivData } from "./pixiv";

const fixtureDirectory = resolve(process.cwd(), "site-htmls");
const hasFixtures = existsSync(join(fixtureDirectory, "pixiv-net-multi-images-before.html"));

describe.skipIf(!hasFixtures)("pixiv collector fixtures", () => {
  it.each([
    "pixiv-net-multi-images-before.html",
    "pixiv-net-multi-images-expanded.html"
  ])("collects every original image from %s", (fixtureName) => {
    const html = readFileSync(join(fixtureDirectory, fixtureName), "utf8");
    const page = new DOMParser().parseFromString(html, "text/html");
    const location = new URL("https://www.pixiv.net/en/artworks/142625231") as unknown as Location;

    const result = collectPixivData(page, location);

    expect(result.ok).toBe(true);
    if (!result.ok || result.outputKind !== "downloadable-files") {
      return;
    }

    expect(result.folderSegments).toEqual(["ミツル-34028718"]);
    expect(result.images.map((image) => image.fileName)).toEqual([
      "142625231_p0.jpg",
      "142625231_p1.jpg"
    ]);
  });
});
