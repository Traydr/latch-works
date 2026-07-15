// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { collectArchiveOfOurOwnData } from "./archiveofourown";
import { collectFanboxData } from "./fanbox";
import { collectFanfictionNetData } from "./fanfiction-net";
import { collectHentaiFoundryStoriesData } from "./hentai-foundry-stories";
import { collectKemonoData } from "./kemono";
import { collectMyHentaiGalleryData } from "./my-hentai-gallery";

function fixture(html: string, url: string): [Document, Location] {
  return [new DOMParser().parseFromString(html, "text/html"), new URL(url) as unknown as Location];
}

describe("MyHentaiGallery collector fixture", () => {
  it("rewrites ordered thumbnails to originals", () => {
    const [document, location] = fixture(
      "<title>Test Comic Hentai Comic - My Hentai Gallery</title><ul class='comics-grid clear'><div class='comic-thumb'><img src='/media/thumbnail/001.webp'></div></ul>",
      "https://myhentaigallery.com/a/99"
    );
    expect(collectMyHentaiGalleryData(document, location)).toMatchObject({
      ok: true,
      site: "myhentaigallery",
      folderSegments: ["Test Comic"],
      images: [{ pageNumber: 1, fileName: "001.webp" }]
    });
  });

  it("reports a missing gallery grid", () => {
    const [document, location] = fixture("", "https://myhentaigallery.com/a/99");
    expect(collectMyHentaiGalleryData(document, location)).toMatchObject({ ok: false, code: "GRID_NOT_FOUND" });
  });
});

describe("Kemono collector fixture", () => {
  it("builds service/user/post folder segments", () => {
    const [document, location] = fixture(
      "<a class='post__user-name' href='/fanbox/user/1'>Artist</a><h1 class='post__title'><span>Post</span></h1><div class='post__files'><a class='fileThumb image-link' href='/data/file.png' download='file.png'><img src='/thumb.png'></a></div>",
      "https://kemono.cr/fanbox/user/1/post/2"
    );
    expect(collectKemonoData(document, location)).toMatchObject({
      ok: true,
      site: "kemono",
      folderSegments: ["fanbox", "Artist", "Post"],
      images: [{ fileName: "file.png" }]
    });
  });

  it("rejects a malformed post path", () => {
    const [document, location] = fixture("", "https://kemono.cr/posts/2");
    expect(collectKemonoData(document, location)).toMatchObject({ ok: false, code: "INVALID_KEMONO_PATH" });
  });
});

describe("FANBOX collector fixture", () => {
  it("deduplicates image links and builds the post folder", () => {
    const link = "https://downloads.fanbox.cc/images/post/1/a.webp";
    const [document, location] = fixture(
      `<article><h1>Post title</h1></article><a href='${link}'></a><a href='${link}'></a>`,
      "https://creator.fanbox.cc/posts/123"
    );
    expect(collectFanboxData(document, location)).toMatchObject({
      ok: true,
      site: "fanbox",
      folderSegments: ["creator", "Post title-123"],
      skippedCount: 1,
      images: [{ fileName: "a.webp" }]
    });
  });

  it("rejects a non-post URL", () => {
    const [document, location] = fixture("", "https://creator.fanbox.cc/profile");
    expect(collectFanboxData(document, location)).toMatchObject({ ok: false, code: "UNSUPPORTED_SITE" });
  });
});

describe("Archive of Our Own collector fixture", () => {
  it("builds a direct site-PDF output", () => {
    const [document, location] = fixture(
      "<div id='workskin'><h2 class='title heading'>Story</h2><h3 class='byline heading'><a rel='author'>Writer</a></h3></div><li class='download'><a href='/downloads/1/story.pdf'>PDF</a></li>",
      "https://archiveofourown.org/works/1"
    );
    expect(collectArchiveOfOurOwnData(document, location)).toMatchObject({
      ok: true,
      site: "archiveofourown",
      folderSegments: [],
      images: [{ fileName: "Writer-Story.pdf" }]
    });
  });

  it("reports a missing PDF link", () => {
    const [document, location] = fixture("", "https://archiveofourown.org/works/1");
    expect(collectArchiveOfOurOwnData(document, location)).toMatchObject({ ok: false, code: "PDF_LINK_NOT_FOUND" });
  });
});

describe("Hentai Foundry story collector fixture", () => {
  it("derives author/title and a direct PDF from the story path", () => {
    const [document, location] = fixture(
      "<a class='pdfLink' href='/stories/story.pdf'>PDF</a>",
      "https://www.hentai-foundry.com/stories/user/Writer/7/My-Story"
    );
    expect(collectHentaiFoundryStoriesData(document, location)).toMatchObject({
      ok: true,
      site: "hentaifoundry-stories",
      title: "My Story",
      images: [{ fileName: "Writer-My_Story.pdf" }]
    });
  });

  it("reports a missing PDF link", () => {
    const [document, location] = fixture("", "https://www.hentai-foundry.com/stories/user/a/1/title");
    expect(collectHentaiFoundryStoriesData(document, location)).toMatchObject({ ok: false, code: "PDF_LINK_NOT_FOUND" });
  });
});

describe("FanFiction.Net collector fixture", () => {
  it("sorts chapters and describes a generated-story output", () => {
    const [document, location] = fixture(
      "<div id='profile_top'><b class='xcontrast_txt'>Story</b><a class='xcontrast_txt' href='/u/1/Writer'>Writer</a><div class='xcontrast_txt'>Summary</div><span class='xgray xcontrast_txt'>Rated T</span></div><select id='chap_select'><option value='2'>Second</option><option value='1'>First</option></select>",
      "https://www.fanfiction.net/s/10/1/Story"
    );
    expect(collectFanfictionNetData(document, location)).toMatchObject({
      ok: true,
      outputKind: "generated-story-pdf",
      fileName: "Writer-Story.pdf",
      chapters: [{ chapterNumber: 1 }, { chapterNumber: 2 }]
    });
  });

  it("rejects a malformed story URL", () => {
    const [document, location] = fixture("", "https://www.fanfiction.net/u/1/Writer");
    expect(collectFanfictionNetData(document, location)).toMatchObject({ ok: false, code: "UNSUPPORTED_SITE" });
  });
});
