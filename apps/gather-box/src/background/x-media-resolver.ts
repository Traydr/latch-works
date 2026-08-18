import { z } from "zod";
import type {
  ResolveXMediaMessage,
  ResolveXMediaResponse,
  XMediaEntry,
  XOperationMetadata,
  XTweetDetailResponse
} from "../shared/x-media";
import {
  X_WEB_BEARER_TOKEN,
  XSyndicationResponseSchema,
  XTweetDetailResponseSchema,
  buildXFeatureValues,
  buildXFieldToggles,
  extractGraphqlMedia,
  parseXMedia
} from "../shared/x-media";

const GUEST_TOKEN_URL = "https://api.x.com/1.1/guest/activate.json";
const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";
const FALLBACK_TWEET_DETAIL_QUERY_ID = "jd3V43oDY9cY7obs1YMfbQ";
const REQUEST_TIMEOUT_MS = 12_000;

/** The operation metadata X embeds in its main bundle is a JSON array of switch names. */
const XOperationListSchema = z.array(z.string());

const GuestTokenResponseSchema = z
  .object({ guest_token: z.string().nullable().catch(null) })
  .catch({ guest_token: null });

const FALLBACK_FEATURE_SWITCHES = [
  "rweb_video_screen_enabled",
  "rweb_cashtags_enabled",
  "profile_label_improvements_pcf_label_in_post_enabled",
  "responsive_web_profile_redirect_enabled",
  "rweb_tipjar_consumption_enabled",
  "verified_phone_label_enabled",
  "creator_subscriptions_tweet_preview_api_enabled",
  "responsive_web_graphql_timeline_navigation_enabled",
  "responsive_web_graphql_skip_user_profile_image_extensions_enabled",
  "premium_content_api_read_enabled",
  "communities_web_enable_tweet_community_results_fetch",
  "c9s_tweet_anatomy_moderator_badge_enabled",
  "responsive_web_grok_analyze_button_fetch_trends_enabled",
  "responsive_web_grok_analyze_post_followups_enabled",
  "rweb_cashtags_composer_attachment_enabled",
  "responsive_web_jetfuel_frame",
  "responsive_web_grok_share_attachment_enabled",
  "responsive_web_grok_annotations_enabled",
  "articles_preview_enabled",
  "responsive_web_edit_tweet_api_enabled",
  "rweb_conversational_replies_downvote_enabled",
  "graphql_is_translatable_rweb_tweet_is_translatable_enabled",
  "view_counts_everywhere_api_enabled",
  "longform_notetweets_consumption_enabled",
  "responsive_web_twitter_article_tweet_consumption_enabled",
  "content_disclosure_indicator_enabled",
  "content_disclosure_ai_generated_indicator_enabled",
  "responsive_web_grok_show_grok_translated_post",
  "responsive_web_grok_analysis_button_from_backend",
  "post_ctas_fetch_enabled",
  "freedom_of_speech_not_reach_fetch_enabled",
  "standardized_nudges_misinfo",
  "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled",
  "longform_notetweets_rich_text_read_enabled",
  "longform_notetweets_inline_media_enabled",
  "responsive_web_grok_image_annotation_enabled",
  "responsive_web_grok_imagine_annotation_enabled",
  "responsive_web_grok_community_note_auto_translation_is_enabled",
  "responsive_web_enhance_cards_enabled"
];

const FALLBACK_FIELD_TOGGLES = [
  "withPayments",
  "withAuxiliaryUserLabels",
  "withArticleRichContentState",
  "withArticlePlainText",
  "withArticleSummaryText",
  "withArticleVoiceOver",
  "withGrokAnalyze",
  "withDisallowedReplyControls"
];

let cachedGuestToken: string | null = null;
const operationCache = new Map<string, XOperationMetadata>();

// Fallback order informed by Cobalt's X extractor:
// https://github.com/imputnet/cobalt/blob/main/api/src/processing/services/twitter.js
export async function resolveXPostMedia(
  message: ResolveXMediaMessage
): Promise<ResolveXMediaResponse> {
  try {
    const syndicationMedia = await requestSyndicationMedia(message.tweetId);
    const parsedSyndication = parseXMedia(syndicationMedia);
    if (parsedSyndication.length > 0) {
      return { ok: true, media: parsedSyndication };
    }

    const operation = await getTweetDetailOperation(message.mainScriptUrl);

    const guestToken = await getGuestToken();
    if (guestToken) {
      const guestBody = await requestTweetDetail(message, operation, {
        authenticated: false,
        guestToken
      });
      const guestMedia = parseXMedia(
        guestBody === null ? [] : extractGraphqlMedia(guestBody, message.tweetId)
      );
      if (guestMedia.length > 0) {
        return { ok: true, media: guestMedia };
      }
    }

    return {
      ok: false,
      message: "X did not return downloadable media for this post. Try reloading the post while signed in.",
      operation
    };
  } catch (error) {
    return {
      ok: false,
      message: `Could not resolve X media: ${getErrorMessage(error instanceof Error ? error : null)}`
    };
  }
}

export function extractTweetDetailOperation(source: string): XOperationMetadata | null {
  const operation = source.match(
    /queryId:"([^"]+)",operationName:"TweetDetail"[\s\S]{0,10000}?featureSwitches:(\[[^\]]*\]),fieldToggles:(\[[^\]]*\])/
  );
  if (!operation) {
    return null;
  }

  try {
    return {
      queryId: operation[1],
      featureSwitches: XOperationListSchema.parse(JSON.parse(operation[2])),
      fieldToggles: XOperationListSchema.parse(JSON.parse(operation[3]))
    };
  } catch {
    return null;
  }
}

async function requestSyndicationMedia(tweetId: string): Promise<XMediaEntry[]> {
  const url = new URL(SYNDICATION_URL);
  url.searchParams.set("id", tweetId);
  url.searchParams.set("token", getSyndicationToken(tweetId));

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      return [];
    }
    return XSyndicationResponseSchema.parse(await response.json()).mediaDetails;
  } catch {
    return [];
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

  return {
    queryId: FALLBACK_TWEET_DETAIL_QUERY_ID,
    featureSwitches: FALLBACK_FEATURE_SWITCHES,
    fieldToggles: FALLBACK_FIELD_TOGGLES
  };
}

async function requestTweetDetail(
  message: ResolveXMediaMessage,
  operation: XOperationMetadata,
  auth: { authenticated: false; guestToken: string }
): Promise<XTweetDetailResponse | null> {
  const url = new URL(`https://api.x.com/graphql/${operation.queryId}/TweetDetail`);
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

  const headers: Record<string, string> = {
    authorization: `Bearer ${X_WEB_BEARER_TOKEN}`,
    "content-type": "application/json",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en"
  };

  headers["x-guest-token"] = auth.guestToken;

  try {
    const response = await fetchWithTimeout(url, {
      credentials: "omit",
      headers
    });
    if (!response.ok) {
      return null;
    }
    return XTweetDetailResponseSchema.parse(await response.json());
  } catch {
    return null;
  }
}

async function getGuestToken(): Promise<string | null> {
  if (cachedGuestToken) {
    return cachedGuestToken;
  }

  try {
    const response = await fetchWithTimeout(GUEST_TOKEN_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${X_WEB_BEARER_TOKEN}` }
    });
    if (!response.ok) {
      return null;
    }
    const body = GuestTokenResponseSchema.parse(await response.json());
    if (body.guest_token !== null) {
      cachedGuestToken = body.guest_token;
    }
  } catch {
    return null;
  }

  return cachedGuestToken;
}

function getSyndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function isAllowedMainScriptUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname === "abs.twimg.com" &&
    url.pathname.startsWith("/responsive-web/client-web/main.") &&
    url.pathname.endsWith(".js")
  );
}

function fetchWithTimeout(input: URL | string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

function getErrorMessage(error: Error | null): string {
  return error === null ? "Unknown X media error" : error.message;
}
