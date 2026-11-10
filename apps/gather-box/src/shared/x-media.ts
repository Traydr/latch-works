import * as z from "zod/mini";
import { lenientArrayOf } from "./lenient-array";

/** Where X serves its web app's main bundle, which names the current TweetDetail operation. */
export const X_MAIN_SCRIPT_PREFIX = "https://abs.twimg.com/responsive-web/client-web/main.";

export const X_WEB_BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// X rejects TweetDetail requests when required switches are present with stale values. These
// defaults mirror the web extractor values used by Cobalt and are only used when the page bundle
// did not expose a value for a switch.
const X_DEFAULT_FEATURE_VALUES = new Map<string, boolean>(
  Object.entries({
    rweb_video_screen_enabled: false,
    payments_enabled: false,
    rweb_xchat_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    rweb_cashtags_enabled: false,
    rweb_cashtags_composer_attachment_enabled: false,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    rweb_conversational_replies_downvote_enabled: false,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_enhance_cards_enabled: false,
  } satisfies Record<string, boolean>),
);

/**
 * The post the X collector asks the background to resolve. The page bundle may not expose a main
 * script URL or any feature switches, so both fall back rather than rejecting the request.
 */
export const XPostQuerySchema = z.object({
  tweetId: z.string(),
  mainScriptUrl: z.catch(z.nullable(z.string()), null),
  featureValues: z.catch(z.record(z.string(), z.boolean()), {}),
});

export type XPostQuery = z.infer<typeof XPostQuerySchema>;

export interface ResolvedXMedia {
  type: "photo" | "video" | "animated_gif";
  originalUrl: string;
  fileName: string;
}

export interface XOperationMetadata {
  queryId: string;
  featureSwitches: string[];
  fieldToggles: string[];
}

/** `operation` is set when a signed-in request from the page could still succeed. */
export type ResolveXMediaResponse =
  | { ok: true; media: ResolvedXMedia[] }
  | { ok: false; message: string; operation?: XOperationMetadata };

/** The TweetDetail operation last seen in X's web bundle, used when the page's own is unreadable. */
export const FALLBACK_TWEET_DETAIL_OPERATION: XOperationMetadata = {
  queryId: "jd3V43oDY9cY7obs1YMfbQ",
  featureSwitches: [...X_DEFAULT_FEATURE_VALUES.keys()],
  fieldToggles: [
    "withPayments",
    "withAuxiliaryUserLabels",
    "withArticleRichContentState",
    "withArticlePlainText",
    "withArticleSummaryText",
    "withArticleVoiceOver",
    "withGrokAnalyze",
    "withDisallowedReplyControls",
  ],
};

/** A guest token for anonymous requests, or the signed-in page session's CSRF token. */
export type XRequestAuth =
  | { kind: "guest"; guestToken: string }
  | { kind: "session"; csrfToken: string };

/** One attempt's media, or why it found none. */
export type XMediaAttempt = { media: ResolvedXMedia[] } | { failure: string };

export interface XTweetDetailRequest {
  url: URL;
  init: RequestInit;
}

/** The same TweetDetail query, sent anonymously from the background or signed in from the page. */
export function buildTweetDetailRequest(
  query: XPostQuery,
  operation: XOperationMetadata,
  auth: XRequestAuth,
): XTweetDetailRequest {
  const base = auth.kind === "guest" ? "https://api.x.com/graphql" : "https://x.com/i/api/graphql";
  const url = new URL(`${base}/${operation.queryId}/TweetDetail`);

  url.searchParams.set(
    "variables",
    JSON.stringify({
      focalTweetId: query.tweetId,
      with_rux_injections: false,
      rankingMode: "Relevance",
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: false,
      withBirdwatchNotes: true,
      withVoice: true,
    }),
  );
  url.searchParams.set(
    "features",
    JSON.stringify(buildXFeatureValues(operation.featureSwitches, query.featureValues)),
  );
  url.searchParams.set("fieldToggles", JSON.stringify(buildXFieldToggles(operation.fieldToggles)));

  const headers = {
    authorization: `Bearer ${X_WEB_BEARER_TOKEN}`,
    "content-type": "application/json",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
  };

  if (auth.kind === "guest") {
    return {
      url,
      init: { credentials: "omit", headers: { ...headers, "x-guest-token": auth.guestToken } },
    };
  }

  return {
    url,
    init: {
      credentials: "include",
      headers: {
        ...headers,
        "x-csrf-token": auth.csrfToken,
        "x-twitter-auth-type": "OAuth2Session",
      },
    },
  };
}

/** Only progressive MP4 variants are downloadable; the rest of the variant list is discarded. */
const XVideoVariantSchema = z.object({
  bitrate: z.catch(z.coerce.number(), 0),
  content_type: z.literal("video/mp4"),
  url: z.string(),
});

const XPhotoEntrySchema = z.object({
  type: z.literal("photo"),
  media_url_https: z.string(),
});

const XVideoEntrySchema = z.object({
  type: z.enum(["video", "animated_gif"]),
  media_url_https: z.catch(z.nullable(z.string()), null),
  video_info: z.catch(z.object({ variants: lenientArrayOf(XVideoVariantSchema) }), {
    variants: [],
  }),
});

const XMediaEntrySchema = z.union([XPhotoEntrySchema, XVideoEntrySchema]);

/** `extended_entities.media` from the syndication and GraphQL responses alike. */
const XMediaListSchema = lenientArrayOf(XMediaEntrySchema);

export type XMediaEntry = z.infer<typeof XMediaEntrySchema>;

export const XSyndicationResponseSchema = z.catch(z.object({ mediaDetails: XMediaListSchema }), {
  mediaDetails: [],
});

const XLegacyMediaSchema = z.object({
  extended_entities: z.catch(z.object({ media: XMediaListSchema }), { media: [] }),
});

/**
 * X nests the tweet under `tweet` when it carries visibility results (age-restricted media, reply
 * limits) and puts nothing at the top-level `legacy`, so neither location can be required.
 */
const XRetweetResultSchema = z.object({
  tweet: z.catch(z.nullable(z.object({ legacy: XLegacyMediaSchema })), null),
  legacy: z.catch(z.nullable(XLegacyMediaSchema), null),
});

const XTweetLegacySchema = z.extend(XLegacyMediaSchema, {
  retweeted_status_result: z.catch(
    z.nullable(z.object({ result: z.catch(z.nullable(XRetweetResultSchema), null) })),
    null,
  ),
});

const XTweetResultSchema = z.object({
  tweet: z.catch(z.nullable(z.object({ legacy: XTweetLegacySchema })), null),
  legacy: z.catch(z.nullable(XTweetLegacySchema), null),
});

const XTimelineEntrySchema = z.object({
  entryId: z.string(),
  content: z.object({
    itemContent: z.object({
      tweet_results: z.object({ result: XTweetResultSchema }),
    }),
  }),
});

const XTimelineInstructionSchema = z.object({
  type: z.string(),
  entries: lenientArrayOf(XTimelineEntrySchema),
});

const XTweetDetailResponseSchema = z.catch(
  z.object({
    data: z.object({
      threaded_conversation_with_injections_v2: z.object({
        instructions: lenientArrayOf(XTimelineInstructionSchema),
      }),
    }),
  }),
  { data: { threaded_conversation_with_injections_v2: { instructions: [] } } },
);

type XTweetDetailResponse = z.infer<typeof XTweetDetailResponseSchema>;

function buildXFeatureValues(
  featureSwitches: string[],
  pageValues: Record<string, boolean>,
): Record<string, boolean> {
  return Object.fromEntries(
    featureSwitches.map((name) => [
      name,
      pageValues[name] ?? X_DEFAULT_FEATURE_VALUES.get(name) ?? false,
    ]),
  );
}

function buildXFieldToggles(fieldToggles: string[]): Record<string, boolean> {
  return Object.fromEntries(
    fieldToggles.map((name) => [name, name === "withArticleRichContentState"]),
  );
}

/** The post's media from a TweetDetail answer, whether the request was a guest's or signed in. */
export async function readTweetDetailMedia(
  response: Response,
  tweetId: string,
): Promise<XMediaAttempt> {
  if (!response.ok) {
    return { failure: `HTTP ${response.status}` };
  }

  const body = XTweetDetailResponseSchema.parse(await response.json());
  const media = parseXMedia(extractGraphqlMedia(body, tweetId));

  return media.length > 0 ? { media } : { failure: "no media" };
}

export function parseXMedia(rawMedia: XMediaEntry[]): ResolvedXMedia[] {
  const result: ResolvedXMedia[] = [];
  const seen = new Set<string>();

  for (const media of rawMedia) {
    if (media.type === "photo") {
      const photo = normalizeXPhotoUrl(media.media_url_https);

      if (!photo || seen.has(photo.originalUrl)) {
        continue;
      }

      seen.add(photo.originalUrl);
      result.push({ type: "photo", ...photo });
      continue;
    }

    const bestVariant = [...media.video_info.variants].sort(
      (left, right) => right.bitrate - left.bitrate,
    )[0];

    if (!bestVariant) {
      continue;
    }

    const url = new URL(bestVariant.url);
    url.searchParams.delete("tag");

    if (seen.has(url.toString())) {
      continue;
    }

    const fileName = getPathFileName(url.pathname);

    if (!fileName) {
      continue;
    }

    seen.add(url.toString());
    result.push({ type: media.type, originalUrl: url.toString(), fileName });
  }

  return result;
}

/**
 * The original of an X photo, from the URL the page renders or the API reports. The format comes
 * from the `format` parameter or, failing that, the path's extension.
 */
export function normalizeXPhotoUrl(
  value: string,
): { originalUrl: string; fileName: string } | null {
  const url = new URL(value);
  const pathFileName = getPathFileName(url.pathname);
  const format = (url.searchParams.get("format") ?? getExtension(pathFileName)).toLowerCase();
  const baseName = stripXMediaExtension(pathFileName);

  if (
    url.hostname !== "pbs.twimg.com" ||
    !url.pathname.startsWith("/media/") ||
    !format ||
    !baseName
  ) {
    return null;
  }

  url.searchParams.set("name", "orig");

  return { originalUrl: url.toString(), fileName: `${baseName}.${format}` };
}

/** An X media file name without its extension: the media id, whatever rendition it names. */
export function stripXMediaExtension(fileName: string): string {
  const extensionStart = fileName.lastIndexOf(".");

  return extensionStart > 0 ? fileName.slice(0, extensionStart) : fileName;
}

function extractGraphqlMedia(response: XTweetDetailResponse, tweetId: string): XMediaEntry[] {
  const { instructions } = response.data.threaded_conversation_with_injections_v2;
  const addEntries = instructions.find((instruction) => instruction.type === "TimelineAddEntries");
  const entry = addEntries?.entries.find((candidate) => candidate.entryId === `tweet-${tweetId}`);
  const tweetResult = entry?.content.itemContent.tweet_results.result;

  if (!tweetResult) {
    return [];
  }

  const legacy = tweetResult.tweet?.legacy ?? tweetResult.legacy;
  const retweetResult = legacy?.retweeted_status_result?.result;
  const retweetLegacy = retweetResult?.tweet?.legacy ?? retweetResult?.legacy;

  return retweetLegacy?.extended_entities.media ?? legacy?.extended_entities.media ?? [];
}

function getPathFileName(pathname: string): string {
  return decodeURIComponent(pathname.split("/").pop() ?? "");
}

function getExtension(fileName: string): string {
  const extensionStart = fileName.lastIndexOf(".");

  return extensionStart > 0 ? fileName.slice(extensionStart + 1) : "";
}
