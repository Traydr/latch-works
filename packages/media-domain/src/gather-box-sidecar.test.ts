import { describe, expect, it } from "vitest";
import {
  GATHER_BOX_SOURCE_SIDECAR_FILENAME,
  GATHER_BOX_SOURCE_SIDECAR_SCHEMA_VERSION,
  type GatherBoxGallerySourceSidecar,
  type GatherBoxSourceSidecar,
  type GatherBoxStorySourceSidecar,
} from "./gather-box-sidecar.js";

describe("gather-box sidecar types", () => {
  it("uses the documented hidden filename", () => {
    expect(GATHER_BOX_SOURCE_SIDECAR_FILENAME).toBe(".latch-works.source.json");
  });

  it("accepts representative gallery and story manifests", () => {
    const gallery = {
      schemaVersion: GATHER_BOX_SOURCE_SIDECAR_SCHEMA_VERSION,
      outputKind: "downloadable-files",
      site: "kemono",
      sourceUrl: "https://example.invalid/kemono/user/sample/post/1001",
      sourceId: "1001",
      title: "Sample_Post_Title",
      downloadedAt: "2026-06-12T18:30:00.000Z",
      files: [
        {
          path: "001.webp",
          index: 1,
          originalUrl: "https://cdn.example.invalid/files/a.webp",
          pageNumber: 1,
        },
      ],
    } satisfies GatherBoxGallerySourceSidecar;

    const story = {
      schemaVersion: GATHER_BOX_SOURCE_SIDECAR_SCHEMA_VERSION,
      outputKind: "generated-story-pdf",
      site: "fanfiction-net",
      sourceUrl: "https://example.invalid/fanfiction/s/42/1/Sample_Story",
      sourceId: "42",
      title: "Sample Story",
      creator: "Sample Author",
      downloadedAt: "2026-06-12T19:00:00.000Z",
      file: {
        path: "Sample_Author-Sample_Story.pdf",
        index: 1,
      },
    } satisfies GatherBoxStorySourceSidecar;

    const manifests: GatherBoxSourceSidecar[] = [gallery, story];
    expect(manifests).toHaveLength(2);
  });
});
