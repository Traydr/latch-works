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
  });

  it("rejects cross-site or unsupported hosts", () => {
    expect(
      isAllowedDownloadUrl("myhentaigallery", "https://evil.example.com/original/page.jpg"),
    ).toBe(false);
    expect(isAllowedDownloadUrl("fanbox", "https://downloads.fanbox.cc/files/image.jpg")).toBe(
      true,
    );
    expect(isAllowedDownloadUrl("fanbox", "https://example.com/image.jpg")).toBe(false);
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
