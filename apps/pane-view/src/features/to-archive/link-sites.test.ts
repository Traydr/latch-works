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
    ["https://tidepool.fanbox.cc/posts/909221?utm_campaign=x", "fanbox.cc/@tidepool/posts/909221"],
    ["https://tidepool.fanbox.cc/", "fanbox.cc/@tidepool"],
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
    // A path a rule doesn't name stays whole, so two such links never share a key.
    ["https://www.reddit.com/r/Art/s/AbC123xyz", "reddit.com/r/art/s/AbC123xyz"],
    ["https://www.reddit.com/r/Art/s/ZzZ999qqq", "reddit.com/r/art/s/ZzZ999qqq"],
    ["https://www.reddit.com/r/Art/wiki/index", "reddit.com/r/Art/wiki/index"],
    ["https://x.com/i/web/status/111", "x.com/i/status/111"],
    ["https://x.com/HarborGlass/lists/9", "x.com/HarborGlass/lists/9"],
    ["https://www.patreon.com/collection/12345", "patreon.com/collection/12345"],
    [
      "https://www.patreon.com/join/inkwellmoth/checkout?rid=1",
      "patreon.com/join/inkwellmoth/checkout?rid=1",
    ],
    [
      "https://www.patreon.com/inkwellmoth/shop/winter-pack-123456",
      "patreon.com/inkwellmoth/shop/winter-pack-123456",
    ],
    ["https://www.patreon.com/file?h=1&i=2", "patreon.com/file?h=1&i=2"],
    ["https://ko-fi.com/c/1a2b3c4d5e", "ko-fi.com/c/1a2b3c4d5e"],
    ["https://ko-fi.com/saltmarshstudio/shop/item-9", "ko-fi.com/saltmarshstudio/shop/item-9"],
    ["https://x.com/search?q=winter&src=typed", "x.com/search?q=winter&src=typed"],
    ["https://kemono.su/posts?q=winter", "kemono.su/posts?q=winter"],
    ["https://example.com:8080/a", "example.com:8080/a"],
    ["https://example.com/a%2Fb", "example.com/a%2Fb"],
    [
      "https://subscribestar.adult/velvetcartograph/about",
      "subscribestar.adult/velvetcartograph/about",
    ],
    // Names the sites read without case, and a site's second host.
    ["https://x.com/HarborGlass/status/1850012", "x.com/harborglass/status/1850012"],
    ["https://www.reddit.com/r/Art/comments/1abcde/x/", "reddit.com/r/art/comments/1abcde"],
    ["https://ao3.org/works/51200417", "archiveofourown.org/works/51200417"],
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

  it("keeps every distinct page on its own key", () => {
    // Each pair is two different things to archive; a rule that collapses a form it doesn't
    // name would give one of them the key of the other, or of the creator page.
    const distinct = [
      "https://www.patreon.com/inkwellmoth",
      "https://www.patreon.com/inkwellmoth/shop/winter-pack-123456",
      "https://www.patreon.com/inkwellmoth/shop/spring-pack-654321",
      "https://www.patreon.com/collection/12345",
      "https://www.patreon.com/collection/67890",
      "https://www.patreon.com/file?h=1&i=2",
      "https://www.patreon.com/file?h=3&i=4",
      "https://www.patreon.com/user?u=111",
      "https://www.patreon.com/user/posts?u=222",
      "https://www.patreon.com/user/about?u=333",
      "https://ko-fi.com/saltmarshstudio",
      "https://ko-fi.com/c/1a2b3c4d5e",
      "https://ko-fi.com/c/9z8y7x6w5v",
      "https://www.fanbox.cc/@alice",
      "https://www.fanbox.cc/@alice/shop/items/12345",
      "https://www.fanbox.cc/@alice/posts/999",
      "https://archiveofourown.org/users/lanternfish",
      "https://archiveofourown.org/users/lanternfish/works",
      "https://archiveofourown.org/users/lanternfish/bookmarks",
      "https://archiveofourown.org/users/lanternfish/pseuds/lanternfish/works",
      "https://archiveofourown.org/users/lanternfish/pseuds/lanternfish/bookmarks",
      "https://archiveofourown.org/users/lanternfish/pseuds/lanternfish/series",
      "https://www.reddit.com/r/art/comments/1abcde/winter_set/",
      "https://www.reddit.com/r/art/comments/1abcde/winter_set/kx9z1f/",
      "https://www.patreon.com/cw/inkwellmoth/collections/999",
      "https://danbooru.donmai.us/posts?md5=abc",
      "https://danbooru.donmai.us/posts?md5=def",
      "https://mega.nz/#F!abc!key",
      "https://mega.nz/#F!def!key2",
      "https://mega.nz/folder/abc#key",
      "https://mega.nz/folder/abc#key/folder/sub1",
      "https://mega.nz/folder/abc#key/folder/sub2",
      "https://x.com/inkfox",
      "https://x.com/inkfox_",
      "https://kemono.cr/patreon/user/88123",
      "https://kemono.cr/patreon/user/88123/community",
      "https://www.pixiv.net/users/4410",
      "https://www.pixiv.net/users/4410/bookmarks/artworks",
      "https://www.reddit.com/r/art",
      "https://www.reddit.com/r/Art/s/AbC123xyz",
      "https://www.reddit.com/r/Art/s/ZzZ999qqq",
      "https://x.com/harborglass",
      "https://x.com/i/web/status/111",
      "https://x.com/i/web/status/222",
      "https://x.com/search?q=a",
      "https://x.com/search?q=b",
    ];

    const keys = distinct.map(canonical);

    expect(new Set(keys).size).toBe(distinct.length);
  });

  it("gives one page one key, however it is written", () => {
    const samePage = [
      ["https://alice.fanbox.cc/shop/items/12345", "https://www.fanbox.cc/@alice/shop/items/12345"],
      ["https://alice.fanbox.cc/posts/999?x=1", "https://www.fanbox.cc/@alice/posts/999?x=1"],
      ["https://www.patreon.com/user/posts?u=222", "https://www.patreon.com/user?u=222"],
      ["https://www.pixiv.net/en/users/4410/illustrations", "https://www.pixiv.net/users/4410"],
      [
        "https://archiveofourown.org/users/lanternfish/pseuds/lanternfish",
        "https://archiveofourown.org/users/lanternfish",
      ],
      [
        "https://www.reddit.com/r/art/comments/1abcde/comment/kx9z1f/",
        "https://www.reddit.com/r/Art/comments/1abcde/winter_set/kx9z1f/",
      ],
      ["https://example.com/page#section-2", "https://example.com/page"],
    ] as const;

    for (const [a, b] of samePage) expect(canonical(a)).toBe(canonical(b));
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
      label: "post/7381",
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

  it("keeps the _, * and ~ that end a link, and drops markdown around one", () => {
    expect(
      extractUrls(
        "https://x.com/inkfox_ and https://mega.nz/folder/abc#Kx9_ then _https://ko-fi.com/name_ " +
          "**https://www.patreon.com/name_**, ~~https://x.com/old~~",
      ),
    ).toEqual([
      "https://x.com/inkfox_",
      "https://mega.nz/folder/abc#Kx9_",
      "https://ko-fi.com/name",
      "https://www.patreon.com/name_",
      "https://x.com/old",
    ]);
  });

  it("unwraps spoilers, brackets and stacked markdown, and stops at CJK punctuation", () => {
    expect(
      extractUrls(
        [
          "||https://kemono.su/patreon/user/123/post/456||",
          "[https://www.patreon.com/inkfox] {https://ko-fi.com/inkfox}",
          "Patreon: https://www.patreon.com/inkfox| Ko-fi: https://ko-fi.com/inkfox_",
          "**(https://x.com/a_)**, _(https://x.com/b)_",
          "pixiv→https://www.pixiv.net/users/123、FANBOX→https://inkfox.fanbox.cc/」",
          "https://x.com/c\u200B",
        ].join("\n"),
      ),
    ).toEqual([
      "https://kemono.su/patreon/user/123/post/456",
      "https://www.patreon.com/inkfox",
      "https://ko-fi.com/inkfox",
      "https://www.patreon.com/inkfox",
      "https://ko-fi.com/inkfox_",
      "https://x.com/a_",
      "https://x.com/b",
      "https://www.pixiv.net/users/123",
      "https://inkfox.fanbox.cc/",
      "https://x.com/c",
    ]);
  });

  it("ends a link where text written straight after it begins", () => {
    expect(
      extractUrls(
        [
          "https://www.patreon.com/posts/summer-pack-123456… and https://www.patreon.com/posts/other-pack-987654🎉",
          "https://www.pixiv.net/artworks/12345678の続きです",
          "続きはこちら→https://name.fanbox.cc/posts/1234567で公開中",
          "“https://x.com/a” — https://x.com/b—enjoy https://x.com/c/status/1:fire:",
        ].join("\n"),
      ),
    ).toEqual([
      "https://www.patreon.com/posts/summer-pack-123456",
      "https://www.patreon.com/posts/other-pack-987654",
      "https://www.pixiv.net/artworks/12345678",
      "https://name.fanbox.cc/posts/1234567",
      "https://x.com/a",
      "https://x.com/b",
      "https://x.com/c/status/1",
    ]);
  });

  it("takes the target of a Markdown link, inside emphasis or not", () => {
    expect(
      extractUrls(
        [
          "New post on **[Patreon](https://www.patreon.com/posts/new-pack-123456)**!",
          "*[Ko-fi](https://ko-fi.com/name)* __[X](https://x.com/name_)__",
          "[https://www.patreon.com/posts/foo-123](https://www.patreon.com/posts/foo-123)",
        ].join("\n"),
      ),
    ).toEqual([
      "https://www.patreon.com/posts/new-pack-123456",
      "https://ko-fi.com/name",
      "https://x.com/name_",
      "https://www.patreon.com/posts/foo-123",
      "https://www.patreon.com/posts/foo-123",
    ]);
  });

  it("drops the markdown of a sentence that ends with its link", () => {
    expect(
      extractUrls(
        [
          "**New post! https://www.patreon.com/posts/winter-118842301**",
          "*new set up: https://x.com/artist/status/123*",
          "~~old link https://ko-fi.com/artist~~ 'https://x.com/quoted_'",
          "https://x.com/a/status/1:fire::fire: https://example.com/wiki/Help:Contents:",
        ].join("\n"),
      ),
    ).toEqual([
      "https://www.patreon.com/posts/winter-118842301",
      "https://x.com/artist/status/123",
      "https://ko-fi.com/artist",
      "https://x.com/quoted_",
      "https://x.com/a/status/1",
      "https://example.com/wiki/Help:Contents",
    ]);
  });

  it("keeps the apostrophes AO3 writes in tag links", () => {
    const tag = "https://archiveofourown.org/tags/Baldur's%20Gate%20(Video%20Games)/works";

    expect(extractUrls(`queue ${tag}.`)).toEqual([tag]);
    expect(parseLink(tag)?.canonicalUrl).toBe(
      "archiveofourown.org/tags/Baldur's%20Gate%20(Video%20Games)/works",
    );
  });

  it("trims a long run of closing brackets in linear time", () => {
    const started = performance.now();

    expect(extractUrls(`https://a.com/x${")".repeat(40_000)}`)).toEqual(["https://a.com/x"]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("takes a lone link typed without a scheme as https", () => {
    expect(extractUrls("  patreon.com/inkwellmoth ")).toEqual(["https://patreon.com/inkwellmoth"]);
    expect(extractUrls("just some words")).toEqual([]);
  });
});
