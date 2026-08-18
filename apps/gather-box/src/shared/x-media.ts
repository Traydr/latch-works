import * as z from "zod/mini";
import { lenientArrayOf } from "./lenient-array";

export const RESOLVE_X_MEDIA_MESSAGE = "GATHER_BOX_RESOLVE_X_MEDIA" as const;
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
    responsive_web_enhance_cards_enabled: false
  } satisfies Record<string, boolean>)
);

/**
 * Sent by the X collector. The page bundle may not expose a main script URL or any feature
 * switches, so both fall back rather than rejecting the request.
 */
export const ResolveXMediaMessageSchema = z.object({
  type: z.literal(RESOLVE_X_MEDIA_MESSAGE),
  tweetId: z.string(),
  mainScriptUrl: z.catch(z.nullable(z.string()), null),
  featureValues: z.catch(z.record(z.string(), z.boolean()), {})
});

export type ResolveXMediaMessage = z.infer<typeof ResolveXMediaMessageSchema>;

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

/** Only progressive MP4 variants are downloadable; the rest of the variant list is discarded. */
const XVideoVariantSchema = z.object({
  bitrate: z.catch(z.coerce.number(), 0),
  content_type: z.literal("video/mp4"),
  url: z.string()
});

const XPhotoEntrySchema = z.object({
  type: z.literal("photo"),
  media_url_https: z.string()
});

const XVideoEntrySchema = z.object({
  type: z.enum(["video", "animated_gif"]),
  media_url_https: z.catch(z.nullable(z.string()), null),
  video_info: z.catch(z.object({ variants: lenientArrayOf(XVideoVariantSchema) }), {
    variants: []
  })
});

const XMediaEntrySchema = z.union([XPhotoEntrySchema, XVideoEntrySchema]);

/** `extended_entities.media` from the syndication and GraphQL responses alike. */
export const XMediaListSchema = lenientArrayOf(XMediaEntrySchema);

export type XMediaEntry = z.infer<typeof XMediaEntrySchema>;

export const XSyndicationResponseSchema = z.catch(
  z.object({ mediaDetails: XMediaListSchema }),
  { mediaDetails: [] }
);

const XLegacyMediaSchema = z.object({
  extended_entities: z.catch(z.object({ media: XMediaListSchema }), { media: [] })
});

/** X wraps a tweet in `tweet` when it carries visibility results. */
const XRetweetResultSchema = z.object({
  __typename: z.catch(z.string(), ""),
  tweet: z.catch(z.nullable(z.object({ legacy: XLegacyMediaSchema })), null),
  legacy: XLegacyMediaSchema
});

const XTweetLegacySchema = z.extend(XLegacyMediaSchema, {
  retweeted_status_result: z.catch(
    z.nullable(z.object({ result: z.catch(z.nullable(XRetweetResultSchema), null) })),
    null
  )
});

const XTweetResultSchema = z.object({
  __typename: z.catch(z.string(), ""),
  tweet: z.catch(z.nullable(z.object({ legacy: XTweetLegacySchema })), null),
  legacy: XTweetLegacySchema
});

const XTimelineEntrySchema = z.object({
  entryId: z.string(),
  content: z.object({
    itemContent: z.object({
      tweet_results: z.object({ result: XTweetResultSchema })
    })
  })
});

const XTimelineInstructionSchema = z.object({
  type: z.string(),
  entries: lenientArrayOf(XTimelineEntrySchema)
});

export const XTweetDetailResponseSchema = z.catch(
  z.object({
    data: z.object({
      threaded_conversation_with_injections_v2: z.object({
        instructions: lenientArrayOf(XTimelineInstructionSchema)
      })
    })
  }),
  { data: { threaded_conversation_with_injections_v2: { instructions: [] } } }
);

export type XTweetDetailResponse = z.infer<typeof XTweetDetailResponseSchema>;

export function buildXFeatureValues(
  featureSwitches: string[],
  pageValues: Record<string, boolean>
): Record<string, boolean> {
  return Object.fromEntries(
    featureSwitches.map((name) => [
      name,
      pageValues[name] ?? X_DEFAULT_FEATURE_VALUES.get(name) ?? false
    ])
  );
}

export function buildXFieldToggles(fieldToggles: string[]): Record<string, boolean> {
  return Object.fromEntries(
    fieldToggles.map((name) => [name, name === "withArticleRichContentState"])
  );
}

export function parseXMedia(rawMedia: XMediaEntry[]): ResolvedXMedia[] {
  const result: ResolvedXMedia[] = [];
  const seen = new Set<string>();

  for (const media of rawMedia) {
    if (media.type === "photo") {
      const url = new URL(media.media_url_https);
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
        thumbnailUrl: media.media_url_https,
        fileName: `${baseName}.${format}`
      });
      continue;
    }

    const bestVariant = [...media.video_info.variants].sort(
      (left, right) => right.bitrate - left.bitrate
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
    result.push({
      type: media.type,
      originalUrl: url.toString(),
      thumbnailUrl: media.media_url_https,
      fileName
    });
  }

  return result;
}

export function extractGraphqlMedia(
  response: XTweetDetailResponse,
  tweetId: string
): XMediaEntry[] {
  const { instructions } = response.data.threaded_conversation_with_injections_v2;
  const addEntries = instructions.find((instruction) => instruction.type === "TimelineAddEntries");
  const entry = addEntries?.entries.find((candidate) => candidate.entryId === `tweet-${tweetId}`);
  const tweetResult = entry?.content.itemContent.tweet_results.result;
  if (!tweetResult) {
    return [];
  }

  const legacy =
    tweetResult.__typename === "TweetWithVisibilityResults"
      ? tweetResult.tweet?.legacy
      : tweetResult.legacy;
  const retweetResult = legacy?.retweeted_status_result?.result;
  const retweetLegacy =
    retweetResult?.__typename === "TweetWithVisibilityResults"
      ? retweetResult.tweet?.legacy
      : retweetResult?.legacy;

  return retweetLegacy?.extended_entities.media ?? legacy?.extended_entities.media ?? [];
}

function getPathFileName(pathname: string): string {
  return decodeURIComponent(pathname.split("/").pop() ?? "");
}

function getPathExtension(pathname: string): string {
  return getPathFileName(pathname).split(".").pop()?.toLowerCase() ?? "";
}
