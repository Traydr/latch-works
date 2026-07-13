import { describe, expect, it } from "vitest";
import { getSiteKeyFromUrl, isSupportedUrl } from "./sites";

describe("site detection", () => {
  it.each([
    ["https://x.com/anska_art/status/2076653334111396311/photo/1", "x"],
    ["https://x.com/idemiiam/status/2073482223752220821/video/1", "x"],
    ["https://www.pixiv.net/en/artworks/142625231", "pixiv"],
    ["https://www.pixiv.net/artworks/142625231", "pixiv"]
  ])("recognizes %s", (url, site) => {
    expect(isSupportedUrl(url)).toBe(true);
    expect(getSiteKeyFromUrl(url)).toBe(site);
  });

  it("does not match non-post X or pixiv pages", () => {
    expect(isSupportedUrl("https://x.com/anska_art")).toBe(false);
    expect(isSupportedUrl("https://www.pixiv.net/en/users/34028718")).toBe(false);
  });
});

