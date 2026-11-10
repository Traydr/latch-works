import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { prepareGatherOutput } from "./source-policies";
import type { DownloadablePayload } from "./types";

describe("X post folders", () => {
  const postFolders = { ...DEFAULT_SETTINGS, xPostFolders: true };

  const xPost = (fileNames: string[]): DownloadablePayload => ({
    ok: true,
    outputKind: "downloadable-files",
    site: "x",
    title: "post",
    pageUrl: "https://x.com/Artist/status/123",
    galleryId: "123",
    folderSegments: ["artist"],
    images: fileNames.map((fileName) => ({
      originalUrl: `https://pbs.twimg.com/media/${fileName}`,
      fileName,
    })),
  });

  it("files a multi-image post under its ID with the post order as a prefix", () => {
    const grouped = prepareGatherOutput(xPost(["GxB.jpg", "GxA.png", "GxC.jpg"]), postFolders);

    expect(grouped).toMatchObject({
      folderSegments: ["artist", "123"],
      images: [{ fileName: "01_GxB.jpg" }, { fileName: "02_GxA.png" }, { fileName: "03_GxC.jpg" }],
    });
  });

  it("leaves single-image posts in the user folder", () => {
    const post = xPost(["GxA.jpg"]);

    expect(prepareGatherOutput(post, postFolders)).toBe(post);
  });
});
