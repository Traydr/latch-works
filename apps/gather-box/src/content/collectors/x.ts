import { toError } from "../../shared/errors";
import { fetchWithTimeout } from "../../shared/fetch";
import { lowercaseFirstAscii } from "../../shared/path";
import {
  type FailedCollectorRequest,
  RESOLVE_X_MEDIA_MESSAGE,
  type ResolveXMediaRequest,
  sendCollectorRequest,
} from "../../shared/protocol/collector";
import type { CollectorResult, DownloadableFile } from "../../shared/types";
import {
  buildTweetDetailRequest,
  normalizeXPhotoUrl,
  type ResolvedXMedia,
  type ResolveXMediaResponse,
  readTweetDetailMedia,
  stripXMediaExtension,
  X_MAIN_SCRIPT_PREFIX,
  type XMediaAttempt,
  type XOperationMetadata,
} from "../../shared/x-media";
import type { SourcePage } from "../collector-entry";

type XMediaResolver = (
  request: ResolveXMediaRequest,
) => Promise<ResolveXMediaResponse | FailedCollectorRequest>;

interface XPost {
  username: string;
  id: string;
}

export async function collect(
  document: Document,
  page: SourcePage,
  resolveMedia: XMediaResolver = sendCollectorRequest,
): Promise<CollectorResult> {
  const { username, postId } = page.address;

  if (!username || !postId) {
    return { ok: false, message: "This X page is not a supported post URL." };
  }

  const post: XPost = { username: decodeURIComponent(username), id: postId };

  // Rendered photos are only what the viewer currently shows: a post can also hold videos or
  // photos that are not on screen. The resolved media list is the complete post; the rendered
  // photos only cover a resolution failure or a photo the resolver did not report.
  const pageImages = collectVisibleXPhotos(document, post);
  const resolution = await resolvePostMedia(document, post, resolveMedia);

  if (resolution.failure && pageImages.length === 0) {
    return { ok: false, message: resolution.failure };
  }

  // Match by media id, not file name: the resolver reports a photo as `ID.jpg` while the page
  // may render the same photo as `ID.webp`, and that rendition has no original to download.
  const resolvedIds = new Set(
    resolution.media.map((media) => stripXMediaExtension(media.fileName)),
  );

  const images: DownloadableFile[] = [
    ...resolution.media,
    ...pageImages.filter((image) => !resolvedIds.has(stripXMediaExtension(image.fileName))),
  ].map(({ originalUrl, fileName }) => ({ originalUrl, fileName }));

  if (images.length === 0) {
    return { ok: false, message: "No downloadable media was found in this X post." };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    title: getXPostTitle(document, post) || `@${post.username} post ${post.id}`,
    galleryId: post.id,
    folderSegments: [lowercaseFirstAscii(post.username)],
    images,
  };
}

async function resolvePostMedia(
  document: Document,
  post: XPost,
  resolveMedia: XMediaResolver,
): Promise<{ media: ResolvedXMedia[]; failure: string | null }> {
  const request: ResolveXMediaRequest = {
    type: RESOLVE_X_MEDIA_MESSAGE,
    tweetId: post.id,
    mainScriptUrl: getXMainScriptUrl(document),
    featureValues: getXFeatureValues(document),
  };

  let response: ResolveXMediaResponse | FailedCollectorRequest;

  try {
    response = await resolveMedia(request);
  } catch (error) {
    return { media: [], failure: toError(error).message };
  }

  if (response.ok) {
    return { media: response.media, failure: null };
  }

  const operation = "operation" in response ? response.operation : undefined;

  if (!operation || !getCookieValue(document.cookie, "ct0")) {
    return { media: [], failure: response.message };
  }

  const signedIn = await resolveSignedInXMedia(request, operation, () =>
    getCookieValue(document.cookie, "ct0"),
  );

  return "media" in signedIn
    ? { media: signedIn.media, failure: null }
    : { media: [], failure: `${response.message} (signed in: ${signedIn.failure})` };
}

function collectVisibleXPhotos(document: Document, post: XPost): DownloadableFile[] {
  const dialogImages = Array.from(
    document.querySelectorAll<HTMLImageElement>(
      '[role="dialog"] [data-testid="swipe-to-dismiss"] img[src*="pbs.twimg.com/media/"]',
    ),
  );

  const postPath = `/${post.username}/status/${post.id}/photo/`;

  const inlineImages = Array.from(
    document.querySelectorAll<HTMLImageElement>(`a[href^="${postPath}"] img[src]`),
  );

  const candidates = dialogImages.length > 0 ? dialogImages : inlineImages;
  const seen = new Set<string>();
  const images: DownloadableFile[] = [];

  for (const image of candidates) {
    const photo = normalizeXPhotoUrl(image.src);

    if (!photo || seen.has(photo.originalUrl)) {
      continue;
    }

    seen.add(photo.originalUrl);
    images.push(photo);
  }

  return images;
}

function getXPostTitle(document: Document, post: XPost): string {
  const permalink = document.querySelector<HTMLAnchorElement>(
    `a[href="/${post.username}/status/${post.id}"]`,
  );

  return (
    permalink
      ?.closest('[data-testid="tweet"]')
      ?.querySelector('[data-testid="tweetText"]')
      ?.textContent?.trim() ?? ""
  );
}

function getXMainScriptUrl(document: Document): string | null {
  return (
    document.querySelector<HTMLScriptElement>(`script[src^="${X_MAIN_SCRIPT_PREFIX}"]`)?.src ?? null
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

    for (const [, name, value] of text.matchAll(pattern)) {
      if (name) values[name] = value === "true";
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

/** The TweetDetail query again, from the page with the signed-in session's cookies. */
async function resolveSignedInXMedia(
  request: ResolveXMediaRequest,
  operation: XOperationMetadata,
  getCsrfToken: () => string | null,
): Promise<XMediaAttempt> {
  const fetchTweetDetail = (csrfToken: string) => {
    const detail = buildTweetDetailRequest(request, operation, { kind: "session", csrfToken });

    return fetchWithTimeout(detail.url, detail.init);
  };

  try {
    const initialCsrfToken = getCsrfToken();

    if (!initialCsrfToken) {
      return { failure: "no session" };
    }

    let response = await fetchTweetDetail(initialCsrfToken);

    if (response.status === 403) {
      // X commonly rotates ct0 on a rejected request. Fetch processes Set-Cookie before resolving,
      // so read document.cookie again and retry once with the new CSRF token.
      const refreshedCsrfToken = getCsrfToken();

      if (refreshedCsrfToken && refreshedCsrfToken !== initialCsrfToken) {
        response = await fetchTweetDetail(refreshedCsrfToken);
      }
    }

    return await readTweetDetailMedia(response, request.tweetId);
  } catch (error) {
    return { failure: toError(error).message };
  }
}
