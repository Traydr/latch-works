import { describe, expect, it } from "vitest";
import { XTweetDetailResponseSchema, extractGraphqlMedia, parseXMedia } from "./x-media";

const VIDEO_MEDIA = {
  type: "video",
  media_url_https: "https://pbs.twimg.com/amplify_video_thumb/1/img/thumb.jpg",
  video_info: {
    variants: [
      { bitrate: 832000, content_type: "video/mp4", url: "https://video.twimg.com/amplify_video/1/vid/avc1/640x360/low.mp4?tag=16" },
      { content_type: "application/x-mpegURL", url: "https://video.twimg.com/amplify_video/1/pl/x.m3u8" },
      { bitrate: 2176000, content_type: "video/mp4", url: "https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/high.mp4?tag=16" }
    ]
  }
};

function tweetDetailResponse<Result>(result: Result) {
  return {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              {
                entryId: "tweet-100",
                sortIndex: "1",
                content: {
                  entryType: "TimelineTimelineItem",
                  itemContent: { itemType: "TimelineTweet", tweet_results: { result } }
                }
              }
            ]
          }
        ]
      }
    }
  };
}

describe("extractGraphqlMedia", () => {
  it("reads media from a plain Tweet result", () => {
    const body = XTweetDetailResponseSchema.parse(
      tweetDetailResponse({
        __typename: "Tweet",
        rest_id: "100",
        legacy: { extended_entities: { media: [VIDEO_MEDIA] } }
      })
    );
    expect(parseXMedia(extractGraphqlMedia(body, "100")).map((m) => m.originalUrl)).toEqual([
      "https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/high.mp4"
    ]);
  });

  it("reads media from a TweetWithVisibilityResults result (age-restricted media)", () => {
    // X wraps sensitive-media tweets: the tweet lives under `tweet`, no top-level `legacy`.
    const body = XTweetDetailResponseSchema.parse(
      tweetDetailResponse({
        __typename: "TweetWithVisibilityResults",
        tweet: { rest_id: "100", legacy: { extended_entities: { media: [VIDEO_MEDIA] } } },
        mediaVisibilityResults: {
          blurred_image_interstitial: { opacity: 0, text: { text: "Age-restricted" }, title: { text: "" } }
        }
      })
    );
    expect(parseXMedia(extractGraphqlMedia(body, "100")).map((m) => m.originalUrl)).toEqual([
      "https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/high.mp4"
    ]);
  });
});
