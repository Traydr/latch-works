import * as z from "zod/mini";
import { toError } from "../shared/errors";
import { fetchWithTimeout } from "../shared/fetch";
import {
  buildTweetDetailRequest,
  FALLBACK_TWEET_DETAIL_OPERATION,
  parseXMedia,
  type ResolveXMediaResponse,
  readTweetDetailMedia,
  X_MAIN_SCRIPT_PREFIX,
  X_WEB_BEARER_TOKEN,
  type XMediaAttempt,
  type XOperationMetadata,
  type XPostQuery,
  XSyndicationResponseSchema,
} from "../shared/x-media";

const GUEST_TOKEN_URL = "https://api.x.com/1.1/guest/activate.json";

const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";

/** The operation metadata X embeds in its main bundle is a JSON array of switch names. */
const XOperationListSchema = z.array(z.string());

const GuestTokenResponseSchema = z.catch(
  z.object({ guest_token: z.catch(z.nullable(z.string()), null) }),
  { guest_token: null },
);

let cachedGuestToken: string | null = null;

const operationCache = new Map<string, XOperationMetadata>();

// Fallback order informed by Cobalt's X extractor:
// https://github.com/imputnet/cobalt/blob/main/api/src/processing/services/twitter.js
export async function resolveXPostMedia(query: XPostQuery): Promise<ResolveXMediaResponse> {
  try {
    const syndication = await requestSyndicationMedia(query.tweetId);

    if ("media" in syndication) {
      return { ok: true, media: syndication.media };
    }

    const operation = await getTweetDetailOperation(query.mainScriptUrl);
    const guest = await requestGuestTweetDetail(query, operation);

    if ("media" in guest) {
      return { ok: true, media: guest.media };
    }

    return {
      ok: false,
      message:
        "X did not return downloadable media for this post " +
        `(syndication: ${syndication.failure}; guest: ${guest.failure}). ` +
        "Try reloading the post while signed in.",
      operation,
    };
  } catch (error) {
    return { ok: false, message: `Could not resolve X media: ${toError(error).message}` };
  }
}

function extractTweetDetailOperation(source: string): XOperationMetadata | null {
  const operation = source.match(
    /queryId:"([^"]+)",operationName:"TweetDetail"[\s\S]{0,10000}?featureSwitches:(\[[^\]]*\]),fieldToggles:(\[[^\]]*\])/,
  );

  const [, queryId, featureSwitches, fieldToggles] = operation ?? [];

  if (!queryId || !featureSwitches || !fieldToggles) {
    return null;
  }

  try {
    return {
      queryId,
      featureSwitches: XOperationListSchema.parse(JSON.parse(featureSwitches)),
      fieldToggles: XOperationListSchema.parse(JSON.parse(fieldToggles)),
    };
  } catch {
    return null;
  }
}

async function requestSyndicationMedia(tweetId: string): Promise<XMediaAttempt> {
  const url = new URL(SYNDICATION_URL);
  url.searchParams.set("id", tweetId);
  url.searchParams.set("token", getSyndicationToken(tweetId));

  try {
    const response = await fetchWithTimeout(url);

    if (!response.ok) {
      return { failure: `HTTP ${response.status}` };
    }

    const media = parseXMedia(XSyndicationResponseSchema.parse(await response.json()).mediaDetails);

    return media.length > 0 ? { media } : { failure: "no media" };
  } catch (error) {
    return { failure: toError(error).message };
  }
}

async function getTweetDetailOperation(mainScriptUrl: string | null): Promise<XOperationMetadata> {
  if (mainScriptUrl && isAllowedMainScriptUrl(mainScriptUrl)) {
    const cached = operationCache.get(mainScriptUrl);

    if (cached) {
      return cached;
    }

    try {
      const response = await fetchWithTimeout(mainScriptUrl);

      if (response.ok) {
        const operation = extractTweetDetailOperation(await response.text());

        if (operation) {
          operationCache.set(mainScriptUrl, operation);

          return operation;
        }
      }
    } catch {
      // Fall through to the last known operation bundled with the extension.
    }
  }

  return FALLBACK_TWEET_DETAIL_OPERATION;
}

/** A rejected guest token is dropped and replaced once, since X expires them without notice. */
async function requestGuestTweetDetail(
  query: XPostQuery,
  operation: XOperationMetadata,
): Promise<XMediaAttempt> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const guestToken = await getGuestToken();

    if ("failure" in guestToken) {
      return { failure: `guest token ${guestToken.failure}` };
    }

    const request = buildTweetDetailRequest(query, operation, {
      kind: "guest",
      guestToken: guestToken.token,
    });

    try {
      const response = await fetchWithTimeout(request.url, request.init);

      if (response.status === 401 || response.status === 403) {
        cachedGuestToken = null;
        continue;
      }

      return await readTweetDetailMedia(response, query.tweetId);
    } catch (error) {
      return { failure: toError(error).message };
    }
  }

  return { failure: "guest token rejected" };
}

async function getGuestToken(): Promise<{ token: string } | { failure: string }> {
  if (cachedGuestToken) {
    return { token: cachedGuestToken };
  }

  try {
    const response = await fetchWithTimeout(GUEST_TOKEN_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${X_WEB_BEARER_TOKEN}` },
    });

    if (!response.ok) {
      return { failure: `HTTP ${response.status}` };
    }

    const body = GuestTokenResponseSchema.parse(await response.json());

    if (body.guest_token === null) {
      return { failure: "missing" };
    }

    cachedGuestToken = body.guest_token;

    return { token: body.guest_token };
  } catch (error) {
    return { failure: toError(error).message };
  }
}

function getSyndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function isAllowedMainScriptUrl(value: string): boolean {
  const url = new URL(value);

  return url.href.startsWith(X_MAIN_SCRIPT_PREFIX) && url.pathname.endsWith(".js");
}
