import { describe, expect, it } from "vitest";
import { parseXMedia } from "../shared/x-media";
import { extractTweetDetailOperation } from "./x-media-resolver";

describe("X media resolver", () => {
  it("extracts the current TweetDetail operation metadata from an X bundle", () => {
    const source =
      'queryId:"query-123",operationName:"TweetDetail",operationType:"query",metadata:{featureSwitches:["one","two"],fieldToggles:["withOne"]}}';

    expect(extractTweetDetailOperation(source)).toEqual({
      queryId: "query-123",
      featureSwitches: ["one", "two"],
      fieldToggles: ["withOne"]
    });
  });

  it("keeps site filenames and selects the highest bitrate MP4", () => {
    const media = parseXMedia([
      {
        type: "photo",
        media_url_https: "https://pbs.twimg.com/media/photoId?format=png&name=small"
      },
      {
        type: "video",
        media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/poster.jpg",
        video_info: {
          variants: [
            {
              bitrate: 256000,
              content_type: "video/mp4",
              url: "https://video.twimg.com/ext_tw_video/1/pu/vid/320x180/low.mp4?tag=12"
            },
            {
              bitrate: 2176000,
              content_type: "video/mp4",
              url: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/high.mp4?tag=12"
            }
          ]
        }
      }
    ]);

    expect(media.map((item) => item.fileName)).toEqual(["photoId.png", "high.mp4"]);
    expect(media[0].originalUrl).toContain("name=orig");
    expect(media[1].originalUrl).not.toContain("tag=");
  });
});
