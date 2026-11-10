import { describe, expect, it } from "vitest";
import showcaseGatherBoxPage from "../../../showcase/src/components/colorblock/GatherBox.astro?raw";
import showcaseSources from "../../../showcase/src/content/docs/supported-sources.mdx?raw";
import showcaseProducts from "../../../showcase/src/data/products.ts?raw";
import readme from "../../README.md?raw";
import {
  GATHER_SOURCES,
  LISTED_GATHER_SOURCES,
  matchGatherSource,
  type SiteKey,
} from "./source-catalog";

/** One eligible page per source; both of its eligibility forms must accept every one. */
const ELIGIBLE_PAGES = {
  myhentaigallery: ["https://myhentaigallery.com/a/12345"],
  kemono: ["https://kemono.cr/fanbox/user/1/post/2", "https://pawchive.pw/patreon/user/3/post/4"],
  fanbox: ["https://creator.fanbox.cc/posts/123"],
  x: ["https://x.com/artist/status/123", "https://x.com/artist/status/123/photo/1"],
  reddit: [
    "https://www.reddit.com/r/pics/comments/abc123/a_title/",
    "https://reddit.com/user/someone/comments/abc123",
  ],
  pixiv: ["https://www.pixiv.net/en/artworks/123", "https://pixiv.net/artworks/123"],
  archiveofourown: ["https://archiveofourown.org/works/123"],
  "hentaifoundry-stories": ["https://www.hentai-foundry.com/stories/user/Author/1/Story-Title"],
  "hentaifoundry-pictures": ["https://www.hentai-foundry.com/pictures/user/Artist/1/Title"],
  danbooru: ["https://danbooru.donmai.us/posts/123"],
  "fanfiction-net": ["https://www.fanfiction.net/s/123/1/Story-Title"],
} satisfies Record<SiteKey, string[]>;

/** Chrome match-pattern semantics for the `https://host/path` patterns the catalog uses. */
function matchesChromePattern(pattern: string, url: string): boolean {
  const [, host = "", path = ""] = /^https:\/\/([^/]+)(\/.*)$/.exec(pattern) ?? [];
  const target = new URL(url);

  const wildcard = (value: string) =>
    value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

  const hostMatches = host.startsWith("*.")
    ? target.hostname === host.slice(2) || target.hostname.endsWith(host.slice(1))
    : target.hostname === host;

  return hostMatches && new RegExp(`^${wildcard(path)}$`).test(target.pathname + target.search);
}

function documentedSites(text: string, heading: string): string[] {
  const start = text.indexOf(heading);
  const section = text.slice(start, text.indexOf("\n## ", start + heading.length));

  return [...section.matchAll(/^\| \**([^|*]+?)\** \|/gm)].flatMap((match) => {
    const site = match[1]?.trim() ?? "";

    return site === "Site" || /^-+$/.test(site) ? [] : [site];
  });
}

/** The names in an English list such as "A, B, and C". */
function listedNames(list: string | undefined): string[] {
  return (list ?? "").split(/,\s*(?:and\s+)?|\s+and\s+/).map((name) => name.trim());
}

describe("Gather Source catalog", () => {
  it("accepts each eligible page by URL pattern and Chrome match alike", () => {
    for (const source of GATHER_SOURCES) {
      for (const url of ELIGIBLE_PAGES[source.key]) {
        expect(matchGatherSource(url)?.source.key, url).toBe(source.key);
        expect(
          source.pageMatches.some((pattern) => matchesChromePattern(pattern, url)),
          url,
        ).toBe(true);
      }
    }
  });

  it("is what the README and the showcase list as supported", () => {
    const listed = LISTED_GATHER_SOURCES.map((source) => source.label);

    expect(documentedSites(readme, "## Supported sites")).toEqual(listed);
    expect(documentedSites(showcaseSources, "## Site appendix")).toEqual(listed);
    expect(
      listedNames(/"Dedicated collectors for (.+)\.",?$/m.exec(showcaseProducts)?.[1]),
    ).toEqual(listed);
    expect(
      JSON.parse(/const sources = (\[[^\]]*\]);/.exec(showcaseGatherBoxPage)?.[1] ?? "[]"),
    ).toEqual(listed);
  });
});
