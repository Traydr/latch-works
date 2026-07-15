import { describe, expect, it, vi } from "vitest";
import { parseRedgifsMedia, resolveRedgifsMedia } from "./redgifs-media-resolver";

describe("RedGIFs media resolver", () => {
  it("uses temporary authorization and prefers the HD MP4", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "temporary-token" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            gif: {
              urls: {
                hd: "https://media.redgifs.com/Example.mp4",
                sd: "https://media.redgifs.com/Example-mobile.mp4",
                poster: "https://media.redgifs.com/Example-poster.jpg"
              }
            }
          })
        )
      );

    await expect(resolveRedgifsMedia("example", fetcher)).resolves.toEqual({
      ok: true,
      media: {
        originalUrl: "https://media.redgifs.com/Example.mp4",
        thumbnailUrl: "https://media.redgifs.com/Example-poster.jpg",
        fileName: "Example.mp4"
      }
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://api.redgifs.com/v2/gifs/example?views=yes",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer temporary-token" })
      })
    );
  });

  it("rejects non-RedGIFs and non-MP4 media URLs", () => {
    expect(
      parseRedgifsMedia(
        {
          gif: {
            urls: {
              hd: "https://evil.example/video.mp4",
              sd: "https://media.redgifs.com/video.webm"
            }
          }
        },
        "example"
      )
    ).toBeNull();
  });
});
