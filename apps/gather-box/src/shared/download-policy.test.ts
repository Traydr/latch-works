import { describe, expect, it } from "vitest";
import { isAllowedDownloadUrl, prepareDownloadImage } from "./download-policy";

describe("download policy", () => {
  it("accepts valid site download URLs", () => {
    expect(
      isAllowedDownloadUrl(
        "myhentaigallery",
        "https://myhentaigallery.com/gallery/original/page-01.jpg",
      ),
    ).toBe(true);
    expect(isAllowedDownloadUrl("fanbox", "https://downloads.fanbox.cc/files/image.jpg")).toBe(
      true,
    );
    expect(
      isAllowedDownloadUrl("x", "https://video.twimg.com/ext_tw_video/1/pu/vid/video.mp4"),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl(
        "pixiv",
        "https://i.pximg.net/img-original/img/2026/03/22/142625231_p0.jpg",
      ),
    ).toBe(true);
    expect(isAllowedDownloadUrl("reddit", "https://i.redd.it/media123.jpg")).toBe(true);
    expect(
      isAllowedDownloadUrl(
        "reddit",
        "https://preview.redd.it/media123.gif?width=1280&format=mp4&signature=abc",
      ),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl("reddit", "https://media.redgifs.com/Example.mp4"),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl("archiveofourown", "https://archiveofourown.org/downloads/1/story.pdf"),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl(
        "archiveofourown",
        "https://download.archiveofourown.org/downloads/1/story.pdf",
      ),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl("hentaifoundry-stories", "https://www.hentai-foundry.com/stories/story.pdf"),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl(
        "hentaifoundry-pictures",
        "https://pictures.hentai-foundry.com/t/TheKite/1200030/TheKite-1200030-image.png",
      ),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl("fanfiction-net", "https://www.fanfiction.net/s/1/2/Test-Story"),
    ).toBe(true);
  });

  it("rejects cross-site or unsupported hosts", () => {
    expect(
      isAllowedDownloadUrl("myhentaigallery", "https://evil.example.com/original/page.jpg"),
    ).toBe(false);
    expect(isAllowedDownloadUrl("fanbox", "https://downloads.fanbox.cc/files/image.jpg")).toBe(
      true,
    );
    expect(isAllowedDownloadUrl("fanbox", "https://example.com/image.jpg")).toBe(false);
    expect(isAllowedDownloadUrl("reddit", "https://evil.example.com/video.mp4")).toBe(false);
    expect(
      isAllowedDownloadUrl("reddit", "https://preview.redd.it/media123.gif?format=png"),
    ).toBe(false);
    expect(isAllowedDownloadUrl("archiveofourown", "https://archiveofourown.org/works/1")).toBe(
      false,
    );
    expect(isAllowedDownloadUrl("hentaifoundry-stories", "https://www.hentai-foundry.com/pictures/1")).toBe(
      false,
    );
    expect(
      isAllowedDownloadUrl(
        "hentaifoundry-pictures",
        "https://thumbs.hentai-foundry.com/thumb.php?pid=1200030",
      ),
    ).toBe(false);
    expect(isAllowedDownloadUrl("fanfiction-net", "https://www.fanfiction.net/u/1/Author")).toBe(
      false,
    );
  });

  it("sanitizes unsafe filenames before download", () => {
    const prepared = prepareDownloadImage("fanbox", {
      fileName: "../../evil name?.jpg",
      originalUrl: "https://downloads.fanbox.cc/files/image.jpg",
      pageNumber: 1,
      thumbnailUrl: null,
    });

    expect(prepared?.fileName).toBe("evil_name_.jpg");
  });
});
