// @vitest-environment jsdom
/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectXData, lowercaseFirstAscii } from "./x";

const fixtureDirectory = resolve(process.cwd(), "site-htmls");
const hasFixtures = existsSync(join(fixtureDirectory, "x-com-image.html"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("X username normalization", () => {
  it("lowercases only an initial ASCII capital", () => {
    expect(lowercaseFirstAscii("Artist_Name")).toBe("artist_Name");
    expect(lowercaseFirstAscii("_Artist")).toBe("_Artist");
    expect(lowercaseFirstAscii("éArtist")).toBe("éArtist");
  });
});

describe.skipIf(!hasFixtures)("X collector fixtures", () => {
  it.each([
    ["x-com-image.html", "anska_art", "2076653334111396311", ["HNHA3s2WsAALV_h.jpg"]],
    [
      "x-com-multi-image.html",
      "rongrongzi07",
      "2061840804394701186",
      ["HJ0hRkgacAATj-j.jpg", "HJ0hRkmasAAokLR.jpg"]
    ]
  ])("collects visible original photos from %s", async (fixtureName, username, postId, fileNames) => {
    const page = parseFixture(fixtureName);
    const resolver = vi.fn();

    const result = await collectXData(
      page,
      new URL(`https://x.com/${username}/status/${postId}/photo/1`) as unknown as Location,
      resolver
    );

    expect(result.ok).toBe(true);
    expect(resolver).not.toHaveBeenCalled();
    if (!result.ok || result.outputKind !== "downloadable-files") {
      return;
    }
    expect(result.folderSegments).toEqual([username]);
    expect(result.images.map((image) => image.fileName)).toEqual(fileNames);
    expect(result.images.every((image) => image.originalUrl.includes("name=orig"))).toBe(true);
  });

  it.each([
    ["x-com-gif.html", "1141763606389972992", "D9hb6hfXYAImUyR.mp4", "animated_gif"],
    ["x-com-video.html", "2073482223752220821", "video-2073482223752220821.mp4", "video"],
    [
      "x-com-video-no-download.html",
      "1284566903420334080",
      "video-1284566903420334080.mp4",
      "video"
    ]
  ])("uses the X resolver for %s", async (fixtureName, postId, fileName, type) => {
    const resolver = vi.fn().mockResolvedValue({
      ok: true,
      media: [
        {
          type,
          originalUrl: `https://video.twimg.com/tweet_video/${fileName}`,
          thumbnailUrl: null,
          fileName
        }
      ]
    });

    const result = await collectXData(
      parseFixture(fixtureName),
      new URL(`https://x.com/Idemiiam/status/${postId}/video/1`) as unknown as Location,
      resolver
    );

    expect(result.ok).toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver.mock.calls[0][0]).toMatchObject({
      tweetId: postId,
      mainScriptUrl: expect.stringContaining(
        "https://abs.twimg.com/responsive-web/client-web/main."
      ),
      featureValues: { rweb_video_screen_enabled: false }
    });
    if (!result.ok || result.outputKind !== "downloadable-files") {
      return;
    }
    expect(result.folderSegments).toEqual(["idemiiam"]);
    expect(result.images[0].fileName).toBe(fileName);
  });

  it("runs the signed-in fallback in the X page context", async () => {
    const page = parseFixture("x-com-video-no-download.html");
    Object.defineProperty(page, "cookie", { configurable: true, value: "ct0=test-csrf" });
    const resolver = vi.fn().mockResolvedValue({
      ok: false,
      message: "Guest lookup returned no media",
      operation: {
        queryId: "query-id",
        featureSwitches: ["feature_one"],
        fieldToggles: ["withArticleRichContentState"]
      }
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            threaded_conversation_with_injections_v2: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: [
                    {
                      entryId: "tweet-1284566903420334080",
                      content: {
                        itemContent: {
                          tweet_results: {
                            result: {
                              __typename: "Tweet",
                              legacy: {
                                extended_entities: {
                                  media: [
                                    {
                                      type: "video",
                                      media_url_https: "https://pbs.twimg.com/poster.jpg",
                                      video_info: {
                                        variants: [
                                          {
                                            bitrate: 1_000_000,
                                            content_type: "video/mp4",
                                            url: "https://video.twimg.com/ext_tw_video/high.mp4?tag=12"
                                          }
                                        ]
                                      }
                                    }
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  ]
                }
              ]
            }
          }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectXData(
      page,
      new URL(
        "https://x.com/idemiiam/status/1284566903420334080/video/1"
      ) as unknown as Location,
      resolver
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://x.com/i/api/graphql/query-id/");
    if (result.ok && result.outputKind === "downloadable-files") {
      expect(result.images[0].fileName).toBe("high.mp4");
    }
  });
});

function parseFixture(fileName: string): Document {
  const html = readFileSync(join(fixtureDirectory, fileName), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}
