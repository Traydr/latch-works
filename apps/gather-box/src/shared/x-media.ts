export const RESOLVE_X_MEDIA_MESSAGE = "GATHER_BOX_RESOLVE_X_MEDIA" as const;
export const X_WEB_BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// X rejects TweetDetail requests when required switches are present with stale values. These
// defaults mirror the web extractor values used by Cobalt and are only used when the page bundle
// did not expose a value for a switch.
const X_DEFAULT_FEATURE_VALUES: Record<string, boolean> = {
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
  responsive_web_enhance_cards_enabled: false
};

export interface ResolveXMediaMessage {
  type: typeof RESOLVE_X_MEDIA_MESSAGE;
  tweetId: string;
  mainScriptUrl: string | null;
  featureValues: Record<string, boolean>;
}

export interface ResolvedXMedia {
  type: "photo" | "video" | "animated_gif";
  originalUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
}

export interface XOperationMetadata {
  queryId: string;
  featureSwitches: string[];
  fieldToggles: string[];
}

export type ResolveXMediaResponse =
  | { ok: true; media: ResolvedXMedia[] }
  | { ok: false; message: string; operation?: XOperationMetadata };

interface XRawMedia {
  type?: unknown;
  media_url_https?: unknown;
  video_info?: {
    variants?: Array<{
      bitrate?: unknown;
      content_type?: unknown;
      url?: unknown;
    }>;
  };
}

export function isResolveXMediaMessage(message: unknown): message is ResolveXMediaMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === RESOLVE_X_MEDIA_MESSAGE &&
    "tweetId" in message &&
    typeof message.tweetId === "string"
  );
}

export function buildXFeatureValues(
  featureSwitches: string[],
  pageValues: Record<string, boolean>
): Record<string, boolean> {
  return Object.fromEntries(
    featureSwitches.map((name) => [
      name,
      pageValues[name] ?? X_DEFAULT_FEATURE_VALUES[name] ?? false
    ])
  );
}

export function buildXFieldToggles(fieldToggles: string[]): Record<string, boolean> {
  return Object.fromEntries(
    fieldToggles.map((name) => [name, name === "withArticleRichContentState"])
  );
}

export function parseXMedia(rawMedia: unknown): ResolvedXMedia[] {
  if (!Array.isArray(rawMedia)) {
    return [];
  }

  const result: ResolvedXMedia[] = [];
  const seen = new Set<string>();

  for (const candidate of rawMedia) {
    if (!isObject(candidate)) {
      continue;
    }

    const media = candidate as XRawMedia;
    const type = media.type;
    const thumbnailUrl = typeof media.media_url_https === "string" ? media.media_url_https : null;

    if (type === "photo" && thumbnailUrl) {
      const url = new URL(thumbnailUrl);
      url.searchParams.set("name", "orig");
      const format = url.searchParams.get("format") ?? getPathExtension(url.pathname);
      const baseName = getPathFileName(url.pathname).replace(/\.[A-Za-z0-9]+$/, "");
      if (!format || !baseName || seen.has(url.toString())) {
        continue;
      }

      seen.add(url.toString());
      result.push({
        type: "photo",
        originalUrl: url.toString(),
        thumbnailUrl,
        fileName: `${baseName}.${format}`
      });
      continue;
    }

    if (type !== "video" && type !== "animated_gif") {
      continue;
    }

    const bestVariant = (media.video_info?.variants ?? [])
      .filter(
        (variant) =>
          variant.content_type === "video/mp4" && typeof variant.url === "string"
      )
      .sort((left, right) => Number(right.bitrate ?? 0) - Number(left.bitrate ?? 0))[0];
    if (!bestVariant || typeof bestVariant.url !== "string") {
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
    result.push({
      type,
      originalUrl: url.toString(),
      thumbnailUrl,
      fileName
    });
  }

  return result;
}

export function extractGraphqlMedia(body: unknown, tweetId: string): unknown {
  if (!isObject(body)) {
    return null;
  }

  const data = isObject(body.data) ? body.data : null;
  const timeline =
    data && isObject(data.threaded_conversation_with_injections_v2)
      ? data.threaded_conversation_with_injections_v2
      : null;
  const instructions = timeline && Array.isArray(timeline.instructions) ? timeline.instructions : [];
  const addEntries = instructions.find(
    (instruction) => isObject(instruction) && instruction.type === "TimelineAddEntries"
  );
  const entries = isObject(addEntries) && Array.isArray(addEntries.entries) ? addEntries.entries : [];
  const entry = entries.find(
    (candidate) => isObject(candidate) && candidate.entryId === `tweet-${tweetId}`
  );
  let tweetResult = getNestedObject(entry, ["content", "itemContent", "tweet_results", "result"]);

  if (tweetResult?.__typename === "TweetWithVisibilityResults" && isObject(tweetResult.tweet)) {
    tweetResult = tweetResult.tweet;
  }

  const legacy = tweetResult && isObject(tweetResult.legacy) ? tweetResult.legacy : null;
  const retweetedResult = getNestedObject(legacy, ["retweeted_status_result", "result"]);
  const unwrappedRetweet =
    retweetedResult?.__typename === "TweetWithVisibilityResults"
      ? getNestedObject(retweetedResult, ["tweet"])
      : retweetedResult;
  const retweetedLegacy =
    unwrappedRetweet && isObject(unwrappedRetweet.legacy) ? unwrappedRetweet.legacy : null;
  const retweetedMedia = getNestedValue(retweetedLegacy, ["extended_entities", "media"]);

  return retweetedMedia ?? getNestedValue(legacy, ["extended_entities", "media"]);
}

function getNestedObject(value: unknown, path: string[]): Record<string, unknown> | null {
  const nested = getNestedValue(value, path);
  return isObject(nested) ? nested : null;
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

function getPathFileName(pathname: string): string {
  return decodeURIComponent(pathname.split("/").pop() ?? "");
}

function getPathExtension(pathname: string): string {
  return getPathFileName(pathname).split(".").pop()?.toLowerCase() ?? "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
