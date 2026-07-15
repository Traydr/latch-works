// @vitest-environment jsdom
/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RESOLVE_REDGIFS_MEDIA_MESSAGE } from "../../shared/reddit-media";
import { collectRedditData } from "./reddit";

const fixtureDirectory = resolve(process.cwd(), "site-htmls");
const fixtureNames = [
  "reddit-com-single-image.html",
  "reddit-com-multi-image.html",
  "reddit-com-single-gif.html",
  "reddit-com-embedded-redgif-video.html"
];
const hasFixtures = fixtureNames.every((name) => existsSync(join(fixtureDirectory, name)));

describe.skipIf(!hasFixtures)("Reddit collector fixtures", () => {
  it("saves a single image directly under the selected folder", async () => {
    const resolver = vi.fn();
    const result = await collectRedditData(
      parseFixture("reddit-com-single-image.html"),
      redditLocation(
        "/r/hentai/comments/1uvr9p0/yani_neko_undressing_chainsmoker_cat_zefrablue/"
      ),
      resolver
    );

    expect(result).toMatchObject({
      ok: true,
      site: "reddit",
      galleryId: "1uvr9p0",
      folderSegments: [],
      images: [
        {
          pageNumber: 1,
          originalUrl: "https://i.redd.it/41k5uevnv2dh1.jpeg",
          fileName: "41k5uevnv2dh1.jpeg"
        }
      ]
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("keeps a single animated GIF and its original extension", async () => {
    const result = await collectRedditData(
      parseFixture("reddit-com-single-gif.html"),
      redditLocation(
        "/r/hentai/comments/1ug63uw/kit_found_a_strange_ship_setting_gameoverse/"
      ),
      vi.fn()
    );

    expect(result).toMatchObject({
      ok: true,
      folderSegments: [],
      images: [
        {
          originalUrl: "https://i.redd.it/l66er2d2km9h1.gif",
          fileName: "l66er2d2km9h1.gif"
        }
      ]
    });
  });

  it("saves galleries in title + post ID folders with ordered original filenames", async () => {
    const result = await collectRedditData(
      parseFixture("reddit-com-multi-image.html"),
      redditLocation(
        "/r/Hololewd/comments/1uurxe0/nerissa_and_shiori_doujin_by_brulee/"
      ),
      vi.fn()
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.outputKind !== "downloadable-files") {
      return;
    }

    expect(result.folderSegments).toEqual(["Nerissa and Shiori Doujin By BruLee_1uurxe0"]);
    expect(result.images).toHaveLength(16);
    expect(result.images[0]).toMatchObject({
      pageNumber: 1,
      originalUrl: "https://i.redd.it/ziux9xme8vch1.jpg",
      fileName: "01_ziux9xme8vch1.jpg"
    });
    expect(result.images[15]).toMatchObject({
      pageNumber: 16,
      originalUrl: "https://i.redd.it/e14xkvme8vch1.jpg",
      fileName: "16_e14xkvme8vch1.jpg"
    });
  });

  it("resolves an embedded RedGIFs post into a direct MP4", async () => {
    const resolver = vi.fn().mockResolvedValue({
      ok: true,
      media: {
        originalUrl: "https://media.redgifs.com/TrustworthyThankfulBream.mp4",
        thumbnailUrl: "https://media.redgifs.com/TrustworthyThankfulBream-poster.jpg",
        fileName: "TrustworthyThankfulBream.mp4"
      }
    });
    const result = await collectRedditData(
      parseFixture("reddit-com-embedded-redgif-video.html"),
      redditLocation(
        "/r/Koreanhottiesreal/comments/1td0jq7/korean_busty_yeon/"
      ),
      resolver
    );

    expect(resolver).toHaveBeenCalledWith({
      type: RESOLVE_REDGIFS_MEDIA_MESSAGE,
      redgifsId: "trustworthythankfulbream"
    });
    expect(result).toMatchObject({
      ok: true,
      folderSegments: [],
      images: [
        {
          originalUrl: "https://media.redgifs.com/TrustworthyThankfulBream.mp4",
          fileName: "TrustworthyThankfulBream.mp4"
        }
      ]
    });
  });
});

function parseFixture(fileName: string): Document {
  const html = readFileSync(join(fixtureDirectory, fileName), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

function redditLocation(pathname: string): Location {
  return new URL(pathname, "https://www.reddit.com") as unknown as Location;
}
