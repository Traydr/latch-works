import { describe, expect, it } from "vitest";
import { isAllowedDownloadUrl, prepareDownloadImage } from "./download-policy";
import type { SiteKey } from "./source-catalog";

/** A file each source really serves, and a neighbouring URL its allowlist must refuse. */
const DOWNLOADS: { site: SiteKey; allowed: string; refused: string }[] = [
  {
    site: "myhentaigallery",
    allowed: "https://cdn.myhentaicomics.com/gallery/original/001.jpg",
    refused: "https://cdn.myhentaicomics.com.evil.example/gallery/original/001.jpg",
  },
  {
    site: "myhentaigallery",
    allowed: "https://myhentaigallery.com/gallery/original/page-01.jpg",
    refused: "https://evil.example.com/original/page.jpg",
  },
  {
    site: "fanbox",
    allowed: "https://downloads.fanbox.cc/files/image.jpg",
    refused: "https://example.com/image.jpg",
  },
  {
    site: "reddit",
    allowed: "https://preview.redd.it/media123.gif?width=1280&format=mp4&signature=abc",
    refused: "https://preview.redd.it/media123.gif?format=png",
  },
  {
    site: "reddit",
    allowed: "https://media.redgifs.com/Example.mp4",
    refused: "https://evil.example.com/video.mp4",
  },
  {
    site: "archiveofourown",
    allowed: "https://archiveofourown.org/downloads/1/story.pdf",
    refused: "https://archiveofourown.org/works/1",
  },
  {
    site: "hentaifoundry-stories",
    allowed: "https://www.hentai-foundry.com/stories/story.pdf",
    refused: "https://www.hentai-foundry.com/pictures/1",
  },
  {
    site: "hentaifoundry-pictures",
    allowed: "https://pictures.hentai-foundry.com/t/TheKite/1200030/TheKite-1200030-image.png",
    refused: "https://thumbs.hentai-foundry.com/thumb.php?pid=1200030",
  },
  {
    site: "danbooru",
    allowed: "https://cdn.donmai.us/original/fc/a4/original-image.jpg?download=1",
    refused: "https://cdn.donmai.us/sample/fc/a4/sample-image.jpg",
  },
  {
    site: "fanfiction-net",
    allowed: "https://www.fanfiction.net/s/1/2/Test-Story",
    refused: "https://www.fanfiction.net/u/1/Author",
  },
];

describe("download policy", () => {
  it.each(DOWNLOADS)("allows $allowed and refuses $refused", ({ site, allowed, refused }) => {
    expect(isAllowedDownloadUrl(site, allowed)).toBe(true);
    expect(isAllowedDownloadUrl(site, refused)).toBe(false);
  });

  it("sanitizes unsafe filenames before download", () => {
    const prepared = prepareDownloadImage("fanbox", {
      fileName: "../../evil name?.jpg",
      originalUrl: "https://downloads.fanbox.cc/files/image.jpg",
    });

    expect(prepared?.fileName).toBe("evil_name_.jpg");
  });
});
