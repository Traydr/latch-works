export type SiteKey =
  | "myhentaigallery"
  | "kemono"
  | "fanbox"
  | "archiveofourown"
  | "hentaifoundry-stories"
  | "fanfiction-net";

export interface SupportedSite {
  key: SiteKey;
  label: string;
  patterns: RegExp[];
}

export const SUPPORTED_SITES: SupportedSite[] = [
  {
    key: "myhentaigallery",
    label: "MyHentaiGallery",
    patterns: [/^https:\/\/myhentaigallery\.com\/a\/[^/?#]+(?:[/?#]|$)/]
  },
  {
    key: "kemono",
    label: "Kemono",
    patterns: [/^https:\/\/kemono\.cr\/[^/]+\/user\/[^/]+\/post\/[^/?#]+(?:[/?#]|$)/]
  },
  {
    key: "fanbox",
    label: "pixivFANBOX",
    patterns: [/^https:\/\/[a-z0-9-]+\.fanbox\.cc\/posts\/[^/?#]+(?:[/?#]|$)/i]
  },
  {
    key: "archiveofourown",
    label: "Archive of Our Own",
    patterns: [/^https:\/\/archiveofourown\.org\/works\/[^/?#]+(?:[/?#]|$)/]
  },
  {
    key: "hentaifoundry-stories",
    label: "Hentai Foundry Stories",
    patterns: [
      /^https:\/\/www\.hentai-foundry\.com\/stories\/user\/[^/]+\/[^/]+\/[^/?#]+(?:[/?#]|$)/
    ]
  },
  {
    key: "fanfiction-net",
    label: "FanFiction.Net",
    patterns: [/^https:\/\/www\.fanfiction\.net\/s\/[^/]+\/[^/]+\/[^/?#]+(?:[/?#]|$)/]
  }
];

export function isSupportedUrl(url: string): boolean {
  return SUPPORTED_SITES.some((site) => site.patterns.some((pattern) => pattern.test(url)));
}

export function getSiteKeyFromUrl(url: string): SiteKey | null {
  const site = SUPPORTED_SITES.find((candidate) =>
    candidate.patterns.some((pattern) => pattern.test(url))
  );

  return site ? site.key : null;
}
