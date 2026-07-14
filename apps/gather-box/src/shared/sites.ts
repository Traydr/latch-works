export type SiteKey =
  | "myhentaigallery"
  | "kemono"
  | "fanbox"
  | "x"
  | "pixiv"
  | "archiveofourown"
  | "hentaifoundry-stories"
  | "fanfiction-net";

export interface SupportedSite {
  key: SiteKey;
  label: string;
  patterns: RegExp[];
  /** Chrome match patterns for context menus and other URL filters. */
  contextMenuPatterns: string[];
}

export const SUPPORTED_SITES: SupportedSite[] = [
  {
    key: "myhentaigallery",
    label: "MyHentaiGallery",
    patterns: [/^https:\/\/myhentaigallery\.com\/a\/[^/?#]+(?:[/?#]|$)/],
    contextMenuPatterns: ["https://myhentaigallery.com/a/*"]
  },
  {
    key: "kemono",
    label: "Kemono",
    patterns: [/^https:\/\/kemono\.cr\/[^/]+\/user\/[^/]+\/post\/[^/?#]+(?:[/?#]|$)/],
    contextMenuPatterns: ["https://kemono.cr/*/user/*/post/*"]
  },
  {
    key: "fanbox",
    label: "pixivFANBOX",
    patterns: [/^https:\/\/[a-z0-9-]+\.fanbox\.cc\/posts\/[^/?#]+(?:[/?#]|$)/i],
    contextMenuPatterns: ["https://*.fanbox.cc/posts/*"]
  },
  {
    key: "x",
    label: "X",
    patterns: [/^https:\/\/x\.com\/[^/?#]+\/status\/\d+(?:\/(?:photo|video)\/\d+)?(?:[/?#]|$)/i],
    contextMenuPatterns: ["https://x.com/*/status/*"]
  },
  {
    key: "pixiv",
    label: "pixiv",
    patterns: [/^https:\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/\d+(?:[/?#]|$)/i],
    contextMenuPatterns: [
      "https://www.pixiv.net/artworks/*",
      "https://www.pixiv.net/*/artworks/*"
    ]
  },
  {
    key: "archiveofourown",
    label: "Archive of Our Own",
    patterns: [/^https:\/\/archiveofourown\.org\/works\/[^/?#]+(?:[/?#]|$)/],
    contextMenuPatterns: ["https://archiveofourown.org/works/*"]
  },
  {
    key: "hentaifoundry-stories",
    label: "Hentai Foundry Stories",
    patterns: [
      /^https:\/\/www\.hentai-foundry\.com\/stories\/user\/[^/]+\/[^/]+\/[^/?#]+(?:[/?#]|$)/
    ],
    contextMenuPatterns: ["https://www.hentai-foundry.com/stories/user/*"]
  },
  {
    key: "fanfiction-net",
    label: "FanFiction.Net",
    patterns: [/^https:\/\/www\.fanfiction\.net\/s\/[^/]+\/[^/]+\/[^/?#]+(?:[/?#]|$)/],
    contextMenuPatterns: ["https://www.fanfiction.net/s/*"]
  }
];

export const CONTEXT_MENU_URL_PATTERNS = SUPPORTED_SITES.flatMap(
  (site) => site.contextMenuPatterns
);

export function isSupportedUrl(url: string): boolean {
  return SUPPORTED_SITES.some((site) => site.patterns.some((pattern) => pattern.test(url)));
}

export function getSiteKeyFromUrl(url: string): SiteKey | null {
  const site = SUPPORTED_SITES.find((candidate) =>
    candidate.patterns.some((pattern) => pattern.test(url))
  );

  return site ? site.key : null;
}
