/**
 * The sites To archive recognises, and the canonical form of a link that decides whether two
 * pasted links are the same one (plan 068). Pure and environment-neutral: the page uses it to
 * show what a typed link is before it is added, and the server to store and compare links.
 *
 * The site list was seeded from Gather Box's source catalog
 * (`apps/gather-box/src/shared/source-catalog.ts`) plus the subscription sites the owner archives
 * by hand. A site is told from the host alone.
 */

export interface LinkSite {
  key: string;
  label: string;
  /** The two or three letters on the site's badge. */
  badge: string;
  /** The badge's background; its letters are white unless `badgeInk` says otherwise. */
  badgeColor: string;
  badgeInk?: string;
  /** Hosts without `www.`; a subdomain of any of them belongs to the site too. */
  hosts: readonly string[];
}

const LINK_SITES = [
  {
    key: "archiveofourown",
    label: "Archive of Our Own",
    badge: "AO3",
    badgeColor: "#990000",
    hosts: ["archiveofourown.org", "ao3.org"],
  },
  {
    key: "fanfiction-net",
    label: "FanFiction.Net",
    badge: "FF",
    badgeColor: "#33507a",
    hosts: ["fanfiction.net"],
  },
  {
    key: "hentaifoundry",
    label: "Hentai Foundry",
    badge: "HF",
    badgeColor: "#6b5b95",
    hosts: ["hentai-foundry.com"],
  },
  {
    key: "kemono",
    label: "Kemono / Pawchive",
    badge: "KM",
    badgeColor: "#3e6b4f",
    hosts: ["kemono.cr", "kemono.su", "kemono.party", "pawchive.pw"],
  },
  { key: "pixiv", label: "pixiv", badge: "PX", badgeColor: "#0f78d4", hosts: ["pixiv.net"] },
  {
    key: "fanbox",
    label: "pixivFANBOX",
    badge: "FB",
    badgeColor: "#f2a51a",
    badgeInk: "#1a1a1a",
    hosts: ["fanbox.cc"],
  },
  {
    key: "danbooru",
    label: "Danbooru",
    badge: "DB",
    badgeColor: "#3b63c4",
    hosts: ["danbooru.donmai.us"],
  },
  { key: "x", label: "X", badge: "X", badgeColor: "#27272a", hosts: ["x.com", "twitter.com"] },
  { key: "reddit", label: "Reddit", badge: "RD", badgeColor: "#d93a00", hosts: ["reddit.com"] },
  {
    key: "myhentaigallery",
    label: "MyHentaiGallery",
    badge: "MH",
    badgeColor: "#9f1239",
    hosts: ["myhentaigallery.com"],
  },
  { key: "patreon", label: "Patreon", badge: "PT", badgeColor: "#e2583e", hosts: ["patreon.com"] },
  { key: "kofi", label: "Ko-fi", badge: "KF", badgeColor: "#2a9fd6", hosts: ["ko-fi.com"] },
  {
    key: "subscribestar",
    label: "SubscribeStar",
    badge: "SS",
    badgeColor: "#b8891f",
    hosts: ["subscribestar.adult", "subscribestar.com"],
  },
] as const satisfies readonly LinkSite[];

const OTHER_SITE = {
  key: "other",
  label: "Other sites",
  badge: "?",
  badgeColor: "#52525b",
  hosts: [],
} as const satisfies LinkSite;

type KnownSite = (typeof LINK_SITES)[number] | typeof OTHER_SITE;

type LinkSiteKey = KnownSite["key"];

const ALL_SITES: readonly KnownSite[] = [...LINK_SITES, OTHER_SITE];

/** The site for a stored key; an unknown key (a site since removed) reads as Other sites. */
export function siteByKey(key: string): LinkSite {
  return ALL_SITES.find((site) => site.key === key) ?? OTHER_SITE;
}

/** The order sites are listed in: the table's order, Other sites last. */
export function siteOrder(key: string): number {
  const index = ALL_SITES.findIndex((site) => site.key === key);

  return index === -1 ? ALL_SITES.length : index;
}

export interface ParsedLink {
  /** The link as given, trimmed. Opening a link opens this. */
  url: string;
  /** Host and path without scheme or `www.`, tracking parameters, or parts that name the same page. */
  canonicalUrl: string;
  site: LinkSiteKey;
  /** A short name for the link: a creator, "Work 51200417", "Post 7712004". */
  label: string;
}

const TRACKING_PARAMETERS = new Set([
  "enteragree",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "ref_url",
  "si",
]);

const SUBDOMAIN_PREFIX = /^(?:www|m|mobile)\./;

/** What a site rule makes of a link's path segments. */
interface SiteForm {
  /** Set when the site writes one page under two hosts; the host otherwise stays as given. */
  host?: string;
  path: string;
  /** Keep only these query parameters; omitted keeps every non-tracking one. */
  keepQuery?: readonly string[];
  label?: string;
}

type SiteRule = (segments: string[], host: string) => SiteForm;

const DROP_QUERY: readonly string[] = [];

/**
 * A path no rule names: the page is the whole path and its query. A rule rewrites only the forms
 * it knows, so two links it doesn't know can never share a key.
 */
function whole(segments: readonly string[]): SiteForm {
  return { path: segmentsPath(segments) };
}

/** An X profile's tabs; `x.com/name/media` is the profile `x.com/name`. */
const X_PROFILE_TABS = new Set(["media", "with_replies", "likes", "highlights", "articles"]);

/** First path segments on X that are X's own pages, not a handle. */
const X_PAGES = new Set([
  "compose",
  "explore",
  "hashtag",
  "home",
  "i",
  "intent",
  "messages",
  "notifications",
  "search",
  "settings",
]);

/** A Patreon creator's tabs; `patreon.com/name/about` is the creator `patreon.com/name`. */
const PATREON_CREATOR_TABS = new Set([
  "about",
  "chats",
  "collections",
  "community",
  "membership",
  "posts",
  "recommendations",
]);

/** A pixiv user's artwork tabs; `pixiv.net/users/N/illustrations` is the user `pixiv.net/users/N`. */
const PIXIV_USER_TABS = new Set(["artworks", "illustrations", "manga"]);

/** A FANBOX creator's tabs; `fanbox.cc/@name/posts` is the creator `fanbox.cc/@name`. */
const FANBOX_CREATOR_TABS = new Set(["plans", "posts"]);

/** A Ko-fi creator's tabs; `ko-fi.com/name/shop` is the creator `ko-fi.com/name`. */
const KOFI_CREATOR_TABS = new Set([
  "about",
  "commissions",
  "gallery",
  "goal",
  "posts",
  "shop",
  "tiers",
]);

/** First path segments on Ko-fi that are Ko-fi's own pages or one item, not a creator. */
const KOFI_PAGES = new Set([
  "album",
  "c",
  "explore",
  "home",
  "i",
  "manage",
  "post",
  "s",
  "search",
  "settings",
]);

/** First path segments on Patreon that name a page of Patreon's own, not a creator. */
const PATREON_PAGES = new Set([
  "checkout",
  "user",
  "collection",
  "explore",
  "file",
  "home",
  "join",
  "library",
  "login",
  "messages",
  "notifications",
  "search",
  "settings",
]);

function lastDigits(segment: string | undefined): string | undefined {
  return segment?.match(/(\d+)$/)?.[1];
}

function segmentsPath(segments: readonly string[]): string {
  return segments.length === 0 ? "" : `/${segments.join("/")}`;
}

const SITE_RULES: Partial<Record<LinkSiteKey, SiteRule>> = {
  archiveofourown(segments) {
    const worksAt = segments.indexOf("works");
    const work = worksAt === -1 ? undefined : segments[worksAt + 1];

    if (work && /^\d+$/.test(work)) {
      return { path: `/works/${work}`, keepQuery: DROP_QUERY, label: `Work ${work}` };
    }

    const [area, user, tab] = segments;

    if (area === "users" && user && (!tab || tab === "profile" || tab === "pseuds")) {
      // /users/name, /users/name/profile and /users/name/pseuds/… are the one author page.
      return { path: `/users/${user}`, keepQuery: DROP_QUERY, label: user };
    }

    if (segments[0] === "series" && segments[1]) {
      return {
        path: `/series/${segments[1]}`,
        keepQuery: DROP_QUERY,
        label: `Series ${segments[1]}`,
      };
    }

    return { path: segmentsPath(segments) };
  },

  "fanfiction-net"(segments) {
    if ((segments[0] === "s" || segments[0] === "u") && segments[1] && /^\d+$/.test(segments[1])) {
      const kind = segments[0] === "s" ? "Story" : "User";

      return {
        path: `/${segments[0]}/${segments[1]}`,
        keepQuery: DROP_QUERY,
        label: `${kind} ${segments[1]}`,
      };
    }

    return { path: segmentsPath(segments) };
  },

  hentaifoundry(segments) {
    // /pictures/user/Name/12345/slug and /stories/user/Name/12345/slug name one work.
    const [area, user, name, id] = segments;

    if ((area === "pictures" || area === "stories") && user === "user" && name) {
      if (id && /^\d+$/.test(id)) {
        const kind = area === "pictures" ? "Picture" : "Story";

        return {
          path: `/${area}/user/${name}/${id}`,
          keepQuery: DROP_QUERY,
          label: `${kind} ${id}`,
        };
      }

      return { path: segmentsPath(segments), keepQuery: DROP_QUERY, label: name };
    }

    if (area === "user" && user) {
      return { path: segmentsPath(segments), keepQuery: DROP_QUERY, label: user };
    }

    return whole(segments);
  },

  kemono(segments) {
    // /<service>/user/<id>/post/<post> and /<service>/user/<id>; pagination (?o=50) is dropped.
    const [service, user, id, post, postId] = segments;

    if (user === "user" && service && id) {
      if (post === "post" && postId) {
        return {
          path: `/${service}/user/${id}/post/${postId}`,
          keepQuery: DROP_QUERY,
          label: `Post ${postId}`,
        };
      }

      if (segments.length === 3) {
        return {
          path: `/${service}/user/${id}`,
          keepQuery: DROP_QUERY,
          label: `${service} user ${id}`,
        };
      }
    }

    return whole(segments);
  },

  pixiv(segments) {
    const rest = segments[0] && /^[a-z]{2}$/.test(segments[0]) ? segments.slice(1) : segments;
    const [area, id] = rest;

    if (area === "artworks" && id) {
      return { path: `/artworks/${id}`, keepQuery: DROP_QUERY, label: `Artwork ${id}` };
    }

    const [, , tab] = rest;

    if (area === "users" && id && (!tab || PIXIV_USER_TABS.has(tab)) && rest.length <= 3) {
      return { path: `/users/${id}`, keepQuery: DROP_QUERY, label: `User ${id}` };
    }

    return { path: segmentsPath(rest) };
  },

  fanbox(segments, host) {
    // creator.fanbox.cc/… and fanbox.cc/@creator/… are one page; keep the second form.
    const subdomain = host.endsWith(".fanbox.cc") ? host.slice(0, -".fanbox.cc".length) : undefined;
    const first = segments[0];
    const handle = subdomain ?? (first?.startsWith("@") ? first.slice(1) : undefined);

    if (!handle) {
      if (first === "posts" && segments[1] && segments.length === 2) {
        return {
          path: `/posts/${segments[1]}`,
          keepQuery: DROP_QUERY,
          label: `Post ${segments[1]}`,
        };
      }

      return whole(segments);
    }

    const rest = subdomain ? segments : segments.slice(1);
    const [area, post] = rest;

    if (area === "posts" && post && rest.length === 2) {
      return {
        host: "fanbox.cc",
        path: `/@${handle}/posts/${post}`,
        keepQuery: DROP_QUERY,
        label: `Post ${post}`,
      };
    }

    if (rest.length === 0 || (rest.length === 1 && area && FANBOX_CREATOR_TABS.has(area))) {
      return { host: "fanbox.cc", path: `/@${handle}`, keepQuery: DROP_QUERY, label: handle };
    }

    return { host: "fanbox.cc", path: `/@${handle}${segmentsPath(rest)}` };
  },

  danbooru(segments) {
    const [area, id] = segments;

    if (area === "posts" && id && /^\d+$/.test(id)) {
      return { path: `/posts/${id}`, keepQuery: DROP_QUERY, label: `Post ${id}` };
    }

    if (area === "posts") {
      // A tag search: the tags are the page.
      return { path: "/posts", keepQuery: ["tags"], label: "Search" };
    }

    return { path: segmentsPath(segments) };
  },

  x(segments) {
    // Handles ignore case on X; /i/web/status/N is /i/status/N.
    const rest =
      segments[0] === "i" && segments[1] === "web" ? ["i", ...segments.slice(2)] : segments;

    const [first, status, id] = rest;
    const handle = first?.toLowerCase();

    if (handle && status === "status" && id) {
      return {
        path: `/${handle}/status/${id}`,
        keepQuery: DROP_QUERY,
        label: handle === "i" ? `Post ${id}` : `@${handle} post`,
      };
    }

    if (handle && !X_PAGES.has(handle) && (!status || X_PROFILE_TABS.has(status))) {
      return { path: `/${handle}`, keepQuery: DROP_QUERY, label: `@${handle}` };
    }

    return whole(rest);
  },

  reddit(segments) {
    const [r, name, area, id] = segments;
    // Subreddit and user names ignore case on Reddit.
    const lower = name?.toLowerCase();

    if (r === "r" && lower && area === "comments" && id) {
      return {
        path: `/r/${lower}/comments/${id}`,
        keepQuery: DROP_QUERY,
        label: `r/${lower} post`,
      };
    }

    if (r === "r" && lower && area === "s" && id) {
      // The app's share link: a short code that stands for one post.
      return { path: `/r/${lower}/s/${id}`, keepQuery: DROP_QUERY, label: `r/${lower} post` };
    }

    if ((r === "u" || r === "user") && lower && segments.length === 2) {
      return { path: `/user/${lower}`, keepQuery: DROP_QUERY, label: `u/${lower}` };
    }

    if (r === "r" && lower && segments.length === 2) {
      return { path: `/r/${lower}`, keepQuery: DROP_QUERY, label: `r/${lower}` };
    }

    return whole(segments);
  },

  patreon(segments) {
    const [first, second, third] = segments.map((segment) => segment.toLowerCase());

    if (first === "posts" && second && segments.length === 2) {
      const id = lastDigits(second) ?? second;

      return { path: `/posts/${id}`, keepQuery: DROP_QUERY, label: `Post ${id}` };
    }

    // /c/name and /cw/name are the creator name, alone or with one of its tabs.
    if (
      (first === "c" || first === "cw") &&
      second &&
      (!third || PATREON_CREATOR_TABS.has(third))
    ) {
      return { path: `/${second}`, keepQuery: DROP_QUERY, label: second };
    }

    if (first === "user" && (!second || (PATREON_CREATOR_TABS.has(second) && !third))) {
      return { path: "/user", keepQuery: ["u"], label: "Creator" };
    }

    const isCreatorPage =
      first !== undefined &&
      !PATREON_PAGES.has(first) &&
      segments.length <= 2 &&
      (!second || PATREON_CREATOR_TABS.has(second));

    if (isCreatorPage) return { path: `/${first}`, keepQuery: DROP_QUERY, label: first };

    return whole(segments);
  },

  kofi(segments) {
    const [first, second] = segments.map((segment) => segment.toLowerCase());

    const isCreatorPage =
      first !== undefined &&
      !KOFI_PAGES.has(first) &&
      segments.length <= 2 &&
      (!second || KOFI_CREATOR_TABS.has(second));

    if (isCreatorPage) return { path: `/${first}`, keepQuery: DROP_QUERY, label: first };

    return whole(segments);
  },

  subscribestar(segments) {
    const lower = segments.map((segment) => segment.toLowerCase());
    const [first, second] = lower;

    if (first === "posts" && second) {
      return { path: `/posts/${second}`, keepQuery: DROP_QUERY, label: `Post ${second}` };
    }

    if (first && lower.length === 1) {
      return { path: `/${first}`, keepQuery: DROP_QUERY, label: first };
    }

    return whole(segments);
  },
};

/** Hosts written two ways for one site. */
function canonicalHost(host: string): string {
  const bare = host.toLowerCase().replace(/\.$/, "").replace(SUBDOMAIN_PREFIX, "");

  if (bare === "twitter.com") return "x.com";

  if (bare === "ao3.org") return "archiveofourown.org";

  if (bare === "old.reddit.com" || bare === "new.reddit.com" || bare === "np.reddit.com") {
    return "reddit.com";
  }

  return bare;
}

function siteForHost(host: string): KnownSite {
  return (
    LINK_SITES.find((site) =>
      site.hosts.some((siteHost) => host === siteHost || host.endsWith(`.${siteHost}`)),
    ) ?? OTHER_SITE
  );
}

function queryString(url: URL, keep: readonly string[] | undefined): string {
  const entries = [...url.searchParams.entries()].filter(([name]) => {
    const lower = name.toLowerCase();

    if (keep) return keep.includes(lower);

    return !lower.startsWith("utm_") && !TRACKING_PARAMETERS.has(lower);
  });

  entries.sort(([a, aValue], [b, bValue]) =>
    a === b ? aValue.localeCompare(bValue) : a < b ? -1 : 1,
  );

  return entries.length === 0 ? "" : `?${new URLSearchParams(entries).toString()}`;
}

function parseHttpUrl(input: string): URL | null {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  if (!url.hostname.includes(".")) return null;

  return url;
}

/** A label as a person reads it: `%E3%81%82` shown as the character it encodes. */
function readableLabel(label: string): string {
  try {
    return decodeURIComponent(label);
  } catch {
    return label;
  }
}

/** Recognises a link and works out its canonical form; null for anything that isn't an http(s) URL. */
export function parseLink(input: string): ParsedLink | null {
  const trimmed = input.trim();
  const url = parseHttpUrl(trimmed);

  if (!url) return null;

  const host = canonicalHost(url.hostname);
  const site = siteForHost(host);
  // Segments stay as the URL parser encoded them, so `a%2Fb` stays one segment.
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const rule = SITE_RULES[site.key];
  const form: SiteForm = rule ? rule(segments, host) : whole(segments);
  const port = url.port ? `:${url.port}` : "";

  return {
    url: trimmed,
    canonicalUrl: `${form.host ?? host}${port}${form.path}${queryString(url, form.keepQuery)}`,
    site: site.key,
    label: readableLabel(form.label ?? (segments.at(-1) || host)),
  };
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
const BARE_LINK = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i;

/** A URL's end, without the punctuation a sentence or a pair of brackets left on it. */
function trimTrailing(candidate: string): string {
  let url = candidate.replace(/[.,;:!?*_~]+$/, "");

  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(/[.,;:!?]+$/, "");
  }

  return url;
}

/**
 * Every http(s) URL in pasted text: a list, chat messages, a single link. A lone link typed
 * without a scheme (`patreon.com/name`) is taken as https.
 */
export function extractUrls(text: string): string[] {
  const found = [...text.matchAll(URL_IN_TEXT)].map((match) => trimTrailing(match[0]));

  if (found.length > 0) return found;

  const trimmed = text.trim();

  return BARE_LINK.test(trimmed) ? [`https://${trimmed}`] : [];
}
