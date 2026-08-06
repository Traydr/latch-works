// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { collectDanbooruData } from "./danbooru";

const postUrl = "https://danbooru.donmai.us/posts/11926515?q=zhu_yuan+";
const originalUrl =
  "https://cdn.donmai.us/original/fc/a4/__wise_and_zhu_yuan__fca4c341.jpg?download=1";

function collect(html: string, url = postUrl) {
  const document = new DOMParser().parseFromString(html, "text/html");
  return collectDanbooruData(document, new URL(url) as unknown as Location);
}

describe("Danbooru collector", () => {
  it("saves the site-named original under the artist instead of the displayed sample", () => {
    const result = collect(`
      <section id="tag-list">
        <ul class="artist-tag-list"><li data-tag-name="zergbrush"></li></ul>
      </section>
      <section class="image-container">
        <img id="image" alt="wise and zhu yuan drawn by zergbrush"
          src="https://cdn.donmai.us/sample/fc/a4/sample-fca4c341.jpg">
      </section>
      <li id="post-option-download">
        <a download="wise and zhu yuan drawn by zergbrush - fca4c341.jpg"
          href="${originalUrl}">Download</a>
      </li>
    `);

    expect(result).toEqual({
      ok: true,
      outputKind: "downloadable-files",
      site: "danbooru",
      title: "wise and zhu yuan drawn by zergbrush",
      pageUrl: postUrl,
      galleryId: "11926515",
      folderSegments: ["zergbrush"],
      skippedCount: 0,
      images: [
        {
          pageNumber: 1,
          thumbnailUrl: "https://cdn.donmai.us/sample/fc/a4/sample-fca4c341.jpg",
          originalUrl,
          fileName: "wise and zhu yuan drawn by zergbrush - fca4c341.jpg"
        }
      ]
    });
  });

  it("falls back to the explicit original link without accepting a sample URL", () => {
    const result = collect(`
      <section id="tag-list">
        <ul class="artist-tag-list"><li data-tag-name="artist_name"></li></ul>
      </section>
      <a class="image-view-original-link"
        href="https://cdn.donmai.us/original/ab/cd/original-file.png">View original</a>
      <img id="image" src="https://cdn.donmai.us/sample/ab/cd/sample-file.jpg">
    `);

    expect(result).toMatchObject({
      ok: true,
      folderSegments: ["artist_name"],
      images: [
        {
          originalUrl: "https://cdn.donmai.us/original/ab/cd/original-file.png",
          fileName: "original-file.png"
        }
      ]
    });
  });

  it("rejects a page that exposes only resized media", () => {
    expect(
      collect(`
        <section id="tag-list">
          <ul class="artist-tag-list"><li data-tag-name="artist_name"></li></ul>
        </section>
        <a class="image-view-original-link"
          href="https://cdn.donmai.us/sample/ab/cd/sample-file.jpg">View image</a>
      `)
    ).toMatchObject({ ok: false, code: "NO_VALID_IMAGES" });
  });
});
