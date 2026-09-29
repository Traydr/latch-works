import type { PageLocation } from "../collector-entry";
import type { GalleryCollectResponse, GalleryImage } from "../../shared/types";
import { formatError, toError } from "../../gather/errors";
import { lowercaseFirstAscii } from "../../shared/path";
import {
  RESOLVE_X_MEDIA_MESSAGE,
  X_WEB_BEARER_TOKEN,
  buildXFeatureValues,
  buildXFieldToggles,
  extractGraphqlMedia,
  parseXMedia,
  XTweetDetailResponseSchema,
  type ResolveXMediaMessage,
  type ResolveXMediaResponse,
  type ResolvedXMedia,
  type XOperationMetadata
} from "../../shared/x-media";

type XMediaResolver = (message: ResolveXMediaMessage) => Promise<ResolveXMediaResponse>;

export async function collectXData(
  document: Document,
  location: PageLocation,
  resolveMedia: XMediaResolver = resolveXMedia
): Promise<GalleryCollectResponse> {
  const post = getXPost(location);

  if (!post) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This X page is not a supported post URL."
    };
  }

  const username = lowercaseFirstAscii(post.username);
  // Rendered photos are only what the viewer currently shows: a post can also hold videos or
  // photos that are not on screen. The resolved media list is the complete post; the rendered
  // photos only cover a resolution failure or a photo the resolver did not report.
  const pageImages = collectVisibleXPhotos(document, post);
  const resolution = await resolvePostMedia(document, post, resolveMedia);

  if (resolution.failure && pageImages.length === 0) {
    return {
      ok: false,
      code: "MEDIA_RESOLUTION_FAILED",
      message: resolution.failure
    };
  }

  // Match by media id, not file name: the resolver reports a photo as `ID.jpg` while the page
  // may render the same photo as `ID.webp`, and that rendition has no original to download.
  const resolvedIds = new Set(resolution.media.map((media) => getXMediaId(media.fileName)));

  const images: GalleryImage[] = [
    ...resolution.media,
    ...pageImages.filter((image) => !resolvedIds.has(getXMediaId(image.fileName)))
  ].map((image, index) => ({
    pageNumber: index + 1,
    thumbnailUrl: image.thumbnailUrl,
    originalUrl: image.originalUrl,
    fileName: image.fileName
  }));

  if (images.length === 0) {
    return {
      ok: false,
      code: "NO_IMAGES_FOUND",
      message: "No downloadable media was found in this X post."
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "x",
    title: getXPostTitle(document, post) || `@${post.username} post ${post.id}`,
    pageUrl: location.href,
    galleryId: post.id,
    folderSegments: [username],
    skippedCount: 0,
    images
  };
}

async function resolvePostMedia(
  document: Document,
  post: { id: string },
  resolveMedia: XMediaResolver
): Promise<{ media: ResolvedXMedia[]; failure: string | null }> {
  const resolveMessage: ResolveXMediaMessage = {
    type: RESOLVE_X_MEDIA_MESSAGE,
    tweetId: post.id,
    mainScriptUrl: getXMainScriptUrl(document),
    featureValues: getXFeatureValues(document)
  };

  let response: ResolveXMediaResponse;

  try {
    response = await resolveMedia(resolveMessage);
  } catch (error) {
    return { media: [], failure: formatError(toError(error)) };
  }

  if (response.ok) {
    return { media: response.media, failure: null };
  }

  const csrfToken = getCookieValue(document.cookie, "ct0");

  const media =
    response.operation && csrfToken
      ? await resolveAuthenticatedXMedia(resolveMessage, response.operation, () =>
          getCookieValue(document.cookie, "ct0")
        )
      : [];

  return { media, failure: media.length > 0 ? null : response.message };
}

function collectVisibleXPhotos(
  document: Document,
  post: { username: string; id: string }
): GalleryImage[] {
  const dialogImages = Array.from(
    document.querySelectorAll<HTMLImageElement>(
      '[role="dialog"] [data-testid="swipe-to-dismiss"] img[src*="pbs.twimg.com/media/"]'
    )
  );

  const postPath = `/${post.username}/status/${post.id}/photo/`;

  const inlineImages = Array.from(
    document.querySelectorAll<HTMLImageElement>(`a[href^="${postPath}"] img[src]`)
  );

  const candidates = dialogImages.length > 0 ? dialogImages : inlineImages;
  const seen = new Set<string>();
  const images: GalleryImage[] = [];

  for (const image of candidates) {
    const normalized = normalizeXPhotoUrl(image.src);

    if (!normalized || seen.has(normalized.originalUrl)) {
      continue;
    }

    seen.add(normalized.originalUrl);
    images.push({
      pageNumber: images.length + 1,
      thumbnailUrl: image.src,
      originalUrl: normalized.originalUrl,
      fileName: normalized.fileName
    });
  }

  return images;
}

function getXMediaId(fileName: string): string {
  const extensionStart = fileName.lastIndexOf(".");

  return extensionStart > 0 ? fileName.slice(0, extensionStart) : fileName;
}

function normalizeXPhotoUrl(urlValue: string): { originalUrl: string; fileName: string } | null {
  const url = new URL(urlValue);
  const format = url.searchParams.get("format")?.toLowerCase();
  const baseName = decodeURIComponent(url.pathname.split("/").pop() ?? "");

  if (
    url.hostname !== "pbs.twimg.com" ||
    !url.pathname.startsWith("/media/") ||
    !format ||
    !baseName
  ) {
    return null;
  }

  url.searchParams.set("name", "orig");

  return {
    originalUrl: url.toString(),
    fileName: `${baseName}.${format}`
  };
}

function getXPost(location: PageLocation): { username: string; id: string } | null {
  const match = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);

  return match ? { username: decodeURIComponent(match[1]), id: match[2] } : null;
}

function getXPostTitle(document: Document, post: { username: string; id: string }): string {
  const permalink = document.querySelector<HTMLAnchorElement>(
    `a[href="/${post.username}/status/${post.id}"]`
  );

  return permalink?.closest('[data-testid="tweet"]')?.querySelector('[data-testid="tweetText"]')
    ?.textContent?.trim() ?? "";
}

function getXMainScriptUrl(document: Document): string | null {
  return (
    document.querySelector<HTMLScriptElement>(
      'script[src^="https://abs.twimg.com/responsive-web/client-web/main."]'
    )?.src ?? null
  );
}

function getXFeatureValues(document: Document) {
  const values: Record<string, boolean> = {};
  const pattern = /["']?([A-Za-z0-9_]+)["']?\s*:\s*\{\s*value\s*:\s*(true|false)/g;

  for (const script of document.scripts) {
    const text = script.textContent ?? "";

    if (!text.includes("featureSwitch")) {
      continue;
    }

    for (const match of text.matchAll(pattern)) {
      values[match[1]] = match[2] === "true";
    }
  }

  return values;
}

function getCookieValue(cookie: string, name: string): string | null {
  for (const part of cookie.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return null;
}

async function resolveXMedia(message: ResolveXMediaMessage): Promise<ResolveXMediaResponse> {
  return chrome.runtime.sendMessage<ResolveXMediaMessage, ResolveXMediaResponse>(message);
}

async function resolveAuthenticatedXMedia(
  message: ResolveXMediaMessage,
  operation: XOperationMetadata,
  getCsrfToken: () => string | null
): Promise<ResolvedXMedia[]> {
  const url = new URL(`https://x.com/i/api/graphql/${operation.queryId}/TweetDetail`);
  url.searchParams.set(
    "variables",
    JSON.stringify({
      focalTweetId: message.tweetId,
      with_rux_injections: false,
      rankingMode: "Relevance",
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: false,
      withBirdwatchNotes: true,
      withVoice: true
    })
  );
  url.searchParams.set(
    "features",
    JSON.stringify(buildXFeatureValues(operation.featureSwitches, message.featureValues))
  );
  url.searchParams.set(
    "fieldToggles",
    JSON.stringify(buildXFieldToggles(operation.fieldToggles))
  );

  try {
    const initialCsrfToken = getCsrfToken();

    if (!initialCsrfToken) {
      return [];
    }

    let response = await fetchAuthenticatedTweetDetail(url, initialCsrfToken);

    if (response.status === 403) {
      // X commonly rotates ct0 on a rejected request. Fetch processes Set-Cookie before resolving,
      // so read document.cookie again and retry once with the new CSRF token.
      const refreshedCsrfToken = getCsrfToken();

      if (refreshedCsrfToken && refreshedCsrfToken !== initialCsrfToken) {
        response = await fetchAuthenticatedTweetDetail(url, refreshedCsrfToken);
      }
    }

    if (!response.ok) {
      return [];
    }

    const body = XTweetDetailResponseSchema.parse(await response.json());

    return parseXMedia(extractGraphqlMedia(body, message.tweetId));
  } catch {
    return [];
  }
}

function fetchAuthenticatedTweetDetail(url: URL, csrfToken: string): Promise<Response> {
  return fetch(url, {
    credentials: "include",
    headers: {
      authorization: `Bearer ${X_WEB_BEARER_TOKEN}`,
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en"
    },
    signal: AbortSignal.timeout(12_000)
  });
}
