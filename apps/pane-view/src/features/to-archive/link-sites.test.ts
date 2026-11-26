import { describe, expect, it } from "vitest";
import { extractUrls, parseLink } from "./link-sites";

function canonical(url: string): string | undefined {
  return parseLink(url)?.canonicalUrl;
}

describe("parseLink", () => {
  it.each([
    // Every link: scheme, www., fragment, tracking parameters, trailing slash.
    ["https://www.example.com/a/b/?utm_source=x&b=2&a=1#top", "example.com/a/b?a=1&b=2"],
    ["http://example.com/a?fbclid=1&ref=discord", "example.com/a"],
    // AO3
    [
      "https://archiveofourown.org/works/51200417/chapters/129433021#workskin",
      "archiveofourown.org/works/51200417",
    ],
    [
      "https://archiveofourown.org/works/51200417?view_full_work=true",
      "archiveofourown.org/works/51200417",
    ],
    [
      "https://archiveofourown.org/collections/fest/works/51200417",
      "archiveofourown.org/works/51200417",
    ],
    [
      "https://archiveofourown.org/users/lanternfish/pseuds/lanternfish",
      "archiveofourown.org/users/lanternfish",
    ],
    // FanFiction.Net
    ["https://www.fanfiction.net/s/14388210/3/Northbound-Eventually", "fanfiction.net/s/14388210"],
    ["https://m.fanfiction.net/s/14388210/1/", "fanfiction.net/s/14388210"],
    // Hentai Foundry
    [
      "https://www.hentai-foundry.com/pictures/user/Copperleaf/1093341/Winter?enterAgree=1",
      "hentai-foundry.com/pictures/user/Copperleaf/1093341",
    ],
    [
      "https://www.hentai-foundry.com/pictures/user/Copperleaf",
      "hentai-foundry.com/pictures/user/Copperleaf",
    ],
    // Kemono and Pawchive keep their own host.
    [
      "https://kemono.cr/patreon/user/88123/post/4410921?o=0",
      "kemono.cr/patreon/user/88123/post/4410921",
    ],
    [
      "https://pawchive.pw/patreon/user/88123/post/4410921",
      "pawchive.pw/patreon/user/88123/post/4410921",
    ],
    ["https://kemono.cr/fanbox/user/3301?o=50", "kemono.cr/fanbox/user/3301"],
    // pixiv
    ["https://www.pixiv.net/en/artworks/120334561", "pixiv.net/artworks/120334561"],
    ["https://www.pixiv.net/users/4410/illustrations", "pixiv.net/users/4410"],
    // FANBOX
    ["https://tidepool.fanbox.cc/posts/909221?utm_campaign=x", "tidepool.fanbox.cc/posts/909221"],
    ["https://www.fanbox.cc/@tidepool/posts/909221", "fanbox.cc/@tidepool/posts/909221"],
    // Danbooru
    ["https://danbooru.donmai.us/posts/7712004?q=saltmarsh", "danbooru.donmai.us/posts/7712004"],
    [
      "https://danbooru.donmai.us/posts?tags=saltmarsh_studio&page=2",
      "danbooru.donmai.us/posts?tags=saltmarsh_studio",
    ],
    // X and Reddit
    [
      "https://twitter.com/harborglass/status/1850012/photo/1?s=20",
      "x.com/harborglass/status/1850012",
    ],
    ["https://x.com/harborglass/media", "x.com/harborglass"],
    [
      "https://old.reddit.com/r/art/comments/1abcde/winter_set/?share_id=x",
      "reddit.com/r/art/comments/1abcde",
    ],
    // Patreon
    ["https://www.patreon.com/c/InkwellMoth/posts?utm_source=discord", "patreon.com/inkwellmoth"],
    ["https://www.patreon.com/inkwellmoth/about", "patreon.com/inkwellmoth"],
    ["https://www.patreon.com/cw/inkwellmoth", "patreon.com/inkwellmoth"],
    ["https://www.patreon.com/posts/winter-set-118842301", "patreon.com/posts/118842301"],
    ["https://www.patreon.com/user?u=5521&utm_medium=x", "patreon.com/user?u=5521"],
    // Ko-fi and SubscribeStar
    ["https://ko-fi.com/SaltmarshStudio/shop", "ko-fi.com/saltmarshstudio"],
    ["https://ko-fi.com/s/a1b2c3", "ko-fi.com/s/a1b2c3"],
    [
      "https://subscribestar.adult/velvetcartograph?ref=discord",
      "subscribestar.adult/velvetcartograph",
    ],
    ["https://www.subscribestar.com/posts/1440021", "subscribestar.com/posts/1440021"],
  ])("%s → %s", (url, expected) => {
    expect(canonical(url)).toBe(expected);
  });

  it("recognises the site and names the link", () => {
    expect(parseLink("https://www.patreon.com/c/inkwellmoth/posts")).toEqual({
      canonicalUrl: "patreon.com/inkwellmoth",
      label: "inkwellmoth",
      site: "patreon",
      url: "https://www.patreon.com/c/inkwellmoth/posts",
    });
    expect(parseLink("https://archiveofourown.org/works/51200417")?.label).toBe("Work 51200417");
    expect(parseLink("https://pawchive.pw/patreon/user/88123/post/4410921")).toMatchObject({
      label: "Post 4410921",
      site: "kemono",
    });
    expect(parseLink("https://tidepool.fanbox.cc/")).toMatchObject({
      label: "tidepool",
      site: "fanbox",
    });
  });

  it("puts an unknown host under Other sites", () => {
    expect(parseLink(" https://glasshouse-gremlin.tumblr.com/post/7381 ")).toEqual({
      canonicalUrl: "glasshouse-gremlin.tumblr.com/post/7381",
      label: "7381",
      site: "other",
      url: "https://glasshouse-gremlin.tumblr.com/post/7381",
    });
  });

  it("refuses what isn't an http(s) link", () => {
    expect(parseLink("ftp://example.com/file")).toBeNull();
    expect(parseLink("javascript:alert(1)")).toBeNull();
    expect(parseLink("not a link")).toBeNull();
    expect(parseLink("http://localhost/x")).toBeNull();
  });
});

describe("extractUrls", () => {
  it("finds every link in pasted chat messages", () => {
    const text = [
      "traydr — 22/11/2026 21:04",
      "finished!! grab it https://archiveofourown.org/works/51200417/chapters/129433021.",
      "<https://ko-fi.com/saltmarshstudio/shop> and (https://danbooru.donmai.us/posts/7712004)",
      "https://en.wikipedia.org/wiki/Glass_(disambiguation)",
    ].join("\n");

    expect(extractUrls(text)).toEqual([
      "https://archiveofourown.org/works/51200417/chapters/129433021",
      "https://ko-fi.com/saltmarshstudio/shop",
      "https://danbooru.donmai.us/posts/7712004",
      "https://en.wikipedia.org/wiki/Glass_(disambiguation)",
    ]);
  });

  it("takes a lone link typed without a scheme as https", () => {
    expect(extractUrls("  patreon.com/inkwellmoth ")).toEqual(["https://patreon.com/inkwellmoth"]);
    expect(extractUrls("just some words")).toEqual([]);
  });
});
