/**
 * The Gather Source catalog: every source's identity, eligible pages, Chrome permissions, collector,
 * output, credential default, download allowlist and save behavior. The build derives the manifest,
 * collector bundles and budgets from it; the runtime derives dispatch, eligibility and policy.
 *
 * It has no imports so `scripts/build.mjs` can load it with Node's type stripping. Code-level
 * source policy (post folders, legacy folders) lives in `source-policies.ts`, keyed by `key`. Each
 * source's collector is `src/content/collectors/<key>.ts`.
 */

export interface SourceSaveBehavior {
  /** Where a gather saves, starting from the chosen folder as `<root>`. */
  pathTemplate: string;
  /** Set only when files are renamed rather than keeping the site's filenames. */
  fileNote?: string;
}

/** A generated story is fetched chapter by chapter in the offscreen document. */
export interface GeneratedStoryOutput {
  kind: "generated-story-pdf";
  /** The element of a fetched chapter page that holds the chapter text. */
  storyTextSelector: string;
  /** The pause between chapter requests, so a long story does not burst the site. */
  chapterFetchDelayMs: number;
}

type GatherSourceOutput = { kind: "downloadable-files" } | GeneratedStoryOutput;

export interface GatherSource<Key extends string = SiteKey> {
  key: Key;
  label: string;
  /**
   * Unlisted sources work exactly like listed ones; they are only kept out of enumerated surfaces
   * (the options page, the side panel's unsupported-page hint, and the site tables in the README
   * and the showcase docs). Runtime status and error messages still name them.
   */
  unlisted?: boolean;
  /** Eligible page URLs. Their named groups reach the collector as the page's parsed address. */
  urlPatterns: readonly RegExp[];
  /** Chrome match patterns for the same pages: the page-shortcut script and the context menu. */
  pageMatches: readonly string[];
  hostPermissions: readonly { pattern: string; reason: string }[];
  output: GatherSourceOutput;
  includeCredentialsByDefault: boolean;
  downloadUrlPatterns: readonly RegExp[];
  /** declarativeNetRequest rule files the source's requests need, listed in the manifest. */
  netRequestRules?: readonly { id: string; path: string }[];
  save: SourceSaveBehavior;
}

const CATALOG = [
  {
    key: "myhentaigallery",
    label: "MyHentaiGallery",
    unlisted: true,
    urlPatterns: [/^https:\/\/myhentaigallery\.com\/a\/(?<galleryId>[^/?#]+)(?:[/?#]|$)/i],
    pageMatches: ["https://myhentaigallery.com/a/*"],
    hostPermissions: [
      { pattern: "https://myhentaigallery.com/*", reason: "Eligible gallery pages" },
      { pattern: "https://cdn.myhentaicomics.com/*", reason: "Original gallery media" },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: false,
    downloadUrlPatterns: [
      /^https:\/\/(?:www\.)?myhentaigallery\.com\/.+\/original\/.+/i,
      /^https:\/\/cdn\.myhentaicomics\.com\/.+\/original\/.+/i,
    ],
    save: { pathTemplate: "<root>/<comic title>/" },
  },
  {
    key: "kemono",
    label: "Kemono",
    unlisted: true,
    urlPatterns: [
      /^https:\/\/(?:kemono\.cr|pawchive\.pw)\/(?<service>[^/]+)\/user\/(?<user>[^/]+)\/post\/(?<postId>[^/?#]+)(?:[/?#]|$)/i,
    ],
    pageMatches: ["https://kemono.cr/*/user/*/post/*", "https://pawchive.pw/*/user/*/post/*"],
    hostPermissions: [
      { pattern: "https://kemono.cr/*", reason: "Eligible post pages and attachments" },
      { pattern: "https://*.kemono.cr/*", reason: "Attachment CDN hosts" },
      { pattern: "https://pawchive.pw/*", reason: "Alternate eligible post pages and attachments" },
      { pattern: "https://*.pawchive.pw/*", reason: "Alternate attachment CDN hosts" },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: false,
    downloadUrlPatterns: [/^https:\/\/(?:[a-z0-9-]+\.)?(?:kemono\.cr|pawchive\.pw)\/.+/i],
    save: { pathTemplate: "<root>/<service>/<user>/<post title>/" },
  },
  {
    key: "fanbox",
    label: "pixivFANBOX",
    unlisted: true,
    urlPatterns: [
      /^https:\/\/(?<creator>[a-z0-9-]+)\.fanbox\.cc\/posts\/(?<postId>[^/?#]+)(?:[/?#]|$)/i,
    ],
    pageMatches: ["https://*.fanbox.cc/posts/*"],
    hostPermissions: [
      { pattern: "https://*.fanbox.cc/*", reason: "Eligible FANBOX post pages" },
      { pattern: "https://downloads.fanbox.cc/*", reason: "FANBOX image downloads" },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: true,
    downloadUrlPatterns: [/^https:\/\/downloads\.fanbox\.cc\/.+/i],
    save: { pathTemplate: "<root>/<creator>/<post title>-<id>/" },
  },
  {
    key: "x",
    label: "X",
    urlPatterns: [
      /^https:\/\/x\.com\/(?<username>[^/?#]+)\/status\/(?<postId>\d+)(?:\/(?:photo|video)\/\d+)?(?:[/?#]|$)/i,
    ],
    pageMatches: ["https://x.com/*/status/*"],
    hostPermissions: [
      { pattern: "https://x.com/*", reason: "Eligible post pages and web media responses" },
      { pattern: "https://api.x.com/*", reason: "Web-client media resolution" },
      { pattern: "https://abs.twimg.com/*", reason: "X web-client bearer metadata" },
      {
        pattern: "https://cdn.syndication.twimg.com/*",
        reason: "Public syndication media resolution",
      },
      { pattern: "https://pbs.twimg.com/*", reason: "Original image media" },
      { pattern: "https://video.twimg.com/*", reason: "Original video media" },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: false,
    downloadUrlPatterns: [
      /^https:\/\/pbs\.twimg\.com\/media\/.+/i,
      /^https:\/\/video\.twimg\.com\/.+\.mp4(?:\?.*)?$/i,
    ],
    save: { pathTemplate: "<root>/<username>/" },
  },
  {
    key: "reddit",
    label: "Reddit",
    urlPatterns: [
      /^https:\/\/(?:www\.)?reddit\.com\/(?:r|user)\/[^/]+\/comments\/(?<postId>[a-z0-9]+)(?:\/[^/?#]+)?(?:[/?#]|$)/i,
    ],
    pageMatches: [
      "https://www.reddit.com/r/*/comments/*",
      "https://reddit.com/r/*/comments/*",
      "https://www.reddit.com/user/*/comments/*",
      "https://reddit.com/user/*/comments/*",
    ],
    hostPermissions: [
      { pattern: "https://www.reddit.com/*", reason: "Eligible Reddit post pages" },
      { pattern: "https://reddit.com/*", reason: "Non-www eligible Reddit post URLs" },
      { pattern: "https://i.redd.it/*", reason: "Original Reddit image and GIF media" },
      {
        pattern: "https://preview.redd.it/*",
        reason: "Reddit gallery thumbnails used to identify originals",
      },
      { pattern: "https://api.redgifs.com/*", reason: "Embedded RedGIFs media resolution" },
      { pattern: "https://*.redgifs.com/*", reason: "Resolved RedGIFs video downloads" },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: false,
    downloadUrlPatterns: [
      /^https:\/\/i\.redd\.it\/.+/i,
      /^https:\/\/preview\.redd\.it\/[a-z0-9]+\.gif\?(?=[^#]*\bformat=mp4(?:&|$))[^#]+$/i,
      /^https:\/\/(?:[a-z0-9-]+\.)?redgifs\.com\/.+\.mp4(?:\?.*)?$/i,
    ],
    netRequestRules: [{ id: "redgifs_api_headers", path: "rules/redgifs-api.json" }],
    save: {
      pathTemplate: "<root>/[<post title>_<id>/]",
      fileNote: "Only galleries get a folder; their files are numbered 01_, 02_, …",
    },
  },
  {
    key: "pixiv",
    label: "pixiv",
    urlPatterns: [
      /^https:\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(?<artworkId>\d+)(?:[/?#]|$)/i,
    ],
    pageMatches: [
      "https://www.pixiv.net/artworks/*",
      "https://www.pixiv.net/*/artworks/*",
      "https://pixiv.net/artworks/*",
      "https://pixiv.net/*/artworks/*",
    ],
    hostPermissions: [
      { pattern: "https://www.pixiv.net/*", reason: "Eligible artwork pages and metadata" },
      { pattern: "https://pixiv.net/*", reason: "Non-www eligible artwork URLs" },
      { pattern: "https://i.pximg.net/*", reason: "Original artwork media" },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: true,
    downloadUrlPatterns: [/^https:\/\/i\.pximg\.net\/img-original\/.+/i],
    netRequestRules: [{ id: "pixiv_referer", path: "rules/pixiv-referer.json" }],
    save: { pathTemplate: "<root>/<username>-<user id>/" },
  },
  {
    key: "archiveofourown",
    label: "Archive of Our Own",
    urlPatterns: [/^https:\/\/archiveofourown\.org\/works\/(?<workId>[^/?#]+)(?:[/?#]|$)/i],
    pageMatches: ["https://archiveofourown.org/works/*"],
    hostPermissions: [
      {
        pattern: "https://archiveofourown.org/*",
        reason: "Eligible works and site-generated PDFs",
      },
      {
        pattern: "https://download.archiveofourown.org/*",
        reason: "Redirected work PDF downloads",
      },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: true,
    downloadUrlPatterns: [
      /^https:\/\/archiveofourown\.org\/downloads\/[^/?#]+\/.+\.pdf(?:\?.*)?$/i,
      /^https:\/\/download\.archiveofourown\.org\/(?:downloads\/)?[^/?#]+\/.+\.pdf(?:\?.*)?$/i,
    ],
    save: { pathTemplate: "<root>/<author>-<story>.pdf" },
  },
  {
    key: "hentaifoundry-stories",
    label: "Hentai Foundry Stories",
    unlisted: true,
    urlPatterns: [
      /^https:\/\/www\.hentai-foundry\.com\/stories\/user\/(?<author>[^/]+)\/(?<storyId>[^/]+)\/(?<title>[^/?#]+)(?:[/?#]|$)/i,
    ],
    pageMatches: ["https://www.hentai-foundry.com/stories/user/*"],
    hostPermissions: [
      {
        pattern: "https://www.hentai-foundry.com/*",
        reason: "Eligible stories and site-generated PDFs",
      },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: true,
    downloadUrlPatterns: [/^https:\/\/www\.hentai-foundry\.com\/stories\/.+\.pdf(?:\?.*)?$/i],
    save: { pathTemplate: "<root>/<author>-<story>.pdf" },
  },
  {
    key: "hentaifoundry-pictures",
    label: "Hentai Foundry Pictures",
    unlisted: true,
    urlPatterns: [
      /^https:\/\/www\.hentai-foundry\.com\/pictures\/user\/(?<artist>[^/]+)\/(?<pictureId>[^/]+)\/(?<title>[^/?#]+)(?:[/?#]|$)/i,
    ],
    pageMatches: ["https://www.hentai-foundry.com/pictures/user/*"],
    hostPermissions: [
      { pattern: "https://www.hentai-foundry.com/*", reason: "Eligible picture pages" },
      { pattern: "https://pictures.hentai-foundry.com/*", reason: "Full-size picture media" },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: true,
    downloadUrlPatterns: [/^https:\/\/pictures\.hentai-foundry\.com\/.+/i],
    save: { pathTemplate: "<root>/<artist>/" },
  },
  {
    key: "danbooru",
    label: "Danbooru",
    unlisted: true,
    urlPatterns: [/^https:\/\/danbooru\.donmai\.us\/posts\/(?<postId>\d+)(?:[/?#]|$)/i],
    pageMatches: ["https://danbooru.donmai.us/posts/*"],
    hostPermissions: [
      { pattern: "https://danbooru.donmai.us/*", reason: "Eligible post pages" },
      { pattern: "https://cdn.donmai.us/*", reason: "Original post media" },
    ],
    output: { kind: "downloadable-files" },
    includeCredentialsByDefault: false,
    downloadUrlPatterns: [/^https:\/\/cdn\.donmai\.us\/original\/.+/i],
    save: { pathTemplate: "<root>/<artist>/" },
  },
  {
    key: "fanfiction-net",
    label: "FanFiction.Net",
    urlPatterns: [
      /^https:\/\/www\.fanfiction\.net\/s\/(?<storyId>[^/]+)\/(?<chapter>[^/]+)\/(?<slug>[^/?#]+)(?:[/?#]|$)/i,
    ],
    pageMatches: ["https://www.fanfiction.net/s/*"],
    hostPermissions: [
      { pattern: "https://www.fanfiction.net/*", reason: "Eligible stories and chapter fetches" },
    ],
    output: {
      kind: "generated-story-pdf",
      storyTextSelector: "#storytext",
      chapterFetchDelayMs: 200,
    },
    includeCredentialsByDefault: false,
    downloadUrlPatterns: [/^https:\/\/www\.fanfiction\.net\/s\/[^/]+\/\d+\/[^/?#]+(?:[/?#]|$)/i],
    save: { pathTemplate: "<root>/<author>-<story>.pdf" },
  },
] as const satisfies readonly GatherSource<string>[];

export type SiteKey = (typeof CATALOG)[number]["key"];

export const GATHER_SOURCES: readonly GatherSource[] = CATALOG;

export const SITE_KEYS: readonly SiteKey[] = CATALOG.map((source) => source.key);

/** Sources safe to enumerate in UI and docs. Use this for any browsable list. */
export const LISTED_GATHER_SOURCES = GATHER_SOURCES.filter((source) => !source.unlisted);

const SOURCES_BY_KEY = new Map<string, GatherSource>(
  GATHER_SOURCES.map((source) => [source.key, source]),
);

export function getGatherSource(siteKey: string): GatherSource | null {
  return SOURCES_BY_KEY.get(siteKey) ?? null;
}

export type PageAddress = Readonly<Partial<Record<string, string>>>;

export interface MatchedPage {
  source: GatherSource;
  address: PageAddress;
}

export function matchGatherSource(url: string): MatchedPage | null {
  for (const source of GATHER_SOURCES) {
    for (const pattern of source.urlPatterns) {
      const match = pattern.exec(url);

      if (match) {
        return { source, address: { ...match.groups } };
      }
    }
  }

  return null;
}

/** Every eligible page's Chrome match pattern, for the page-shortcut script and the context menu. */
export function getPageMatches(): string[] {
  return [...new Set(GATHER_SOURCES.flatMap((source) => source.pageMatches))].sort();
}

/** Problems the build refuses to package: unsafe Chrome matches and unexplained permissions. */
export function findCatalogProblems(sources: readonly GatherSource[] = GATHER_SOURCES): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();

  for (const source of sources) {
    if (keys.has(source.key)) {
      problems.push(`Gather Source ${source.key} is declared twice.`);
    }

    keys.add(source.key);

    for (const pattern of [
      ...source.pageMatches,
      ...source.hostPermissions.map((permission) => permission.pattern),
    ]) {
      if (!pattern.startsWith("https://") || pattern.startsWith("https://*/*")) {
        problems.push(`Gather Source ${source.key} declares an unsafe Chrome match: ${pattern}`);
      }
    }

    if (source.hostPermissions.some((permission) => permission.reason.trim() === "")) {
      problems.push(`Gather Source ${source.key} declares a host permission without a reason.`);
    }

    if (source.urlPatterns.length === 0 || source.downloadUrlPatterns.length === 0) {
      problems.push(`Gather Source ${source.key} is missing page or download patterns.`);
    }
  }

  return problems;
}
