// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ResolveXMediaResponse } from "../../shared/x-media";
import { collectXData } from "./x";

const location = new URL("https://x.com/artist/status/123");

function postWithVisiblePhoto(format = "jpg"): Document {
  document.body.innerHTML = `
    <a href="/artist/status/123/photo/1">
      <img src="https://pbs.twimg.com/media/PHOTO?format=${format}&amp;name=small">
    </a>
    <video poster="https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/poster.jpg"></video>`;

  return document;
}

describe("X collector", () => {
  it("keeps a mixed-media post's video alongside its visible photo", async () => {
    const resolved: ResolveXMediaResponse = {
      ok: true,
      media: [
        {
          type: "photo",
          originalUrl: "https://pbs.twimg.com/media/PHOTO.jpg?name=orig",
          thumbnailUrl: "https://pbs.twimg.com/media/PHOTO.jpg",
          fileName: "PHOTO.jpg"
        },
        {
          type: "video",
          originalUrl: "https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/clip.mp4",
          thumbnailUrl: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/poster.jpg",
          fileName: "clip.mp4"
        }
      ]
    };

    for (const format of ["jpg", "webp"]) {
      const collected = await collectXData(
        postWithVisiblePhoto(format),
        location,
        async () => resolved
      );

      expect(collected).toMatchObject({
        ok: true,
        images: [{ fileName: "PHOTO.jpg" }, { fileName: "clip.mp4" }]
      });
    }
  });

  it("falls back to visible photos when media resolution fails", async () => {
    const collected = await collectXData(postWithVisiblePhoto(), location, async () => ({
      ok: false,
      message: "Syndication unavailable."
    }));

    expect(collected).toMatchObject({
      ok: true,
      images: [
        {
          fileName: "PHOTO.jpg",
          originalUrl: "https://pbs.twimg.com/media/PHOTO?format=jpg&name=orig"
        }
      ]
    });
  });
});
