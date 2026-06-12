/** Hidden sidecar filename written beside Gather Box downloads (design only — not written yet). */
export const GATHER_BOX_SOURCE_SIDECAR_FILENAME = ".latch-works.source.json";

/** Current sidecar manifest schema version. Bump for breaking shape changes. */
export const GATHER_BOX_SOURCE_SIDECAR_SCHEMA_VERSION = 1;

/** Gather Box site keys — mirrors `SiteKey` in the extension. */
export type GatherBoxSiteKey =
  | "myhentaigallery"
  | "kemono"
  | "fanbox"
  | "archiveofourown"
  | "hentaifoundry-stories"
  | "fanfiction-net";

export type GatherBoxOutputKind = "downloadable-files" | "generated-story-pdf";

export interface GatherBoxSourceFileEntry {
  /** Basename relative to the sidecar's parent folder. */
  path: string;
  /** 1-based sequence index within the download set. */
  index: number;
  /** Remote URL when safe to store (no embedded credentials). */
  originalUrl?: string;
  /** Source page/chapter number when the collector tracked one. */
  pageNumber?: number;
}

export interface GatherBoxStoryChapterEntry {
  chapterNumber: number;
  label: string;
  url: string;
}

interface GatherBoxSourceSidecarBase {
  schemaVersion: number;
  outputKind: GatherBoxOutputKind;
  /** Known site key or a future extension-defined key. */
  site: GatherBoxSiteKey | (string & {});
  sourceUrl: string;
  title: string;
  downloadedAt: string;
  gatherBoxVersion?: string;
  skippedCount?: number;
}

export interface GatherBoxGallerySourceSidecar extends GatherBoxSourceSidecarBase {
  outputKind: "downloadable-files";
  sourceId: string | null;
  creator?: string;
  files: GatherBoxSourceFileEntry[];
}

export interface GatherBoxStorySourceSidecar extends GatherBoxSourceSidecarBase {
  outputKind: "generated-story-pdf";
  sourceId: string;
  creator: string;
  summary?: string;
  file: GatherBoxSourceFileEntry;
  chapters?: GatherBoxStoryChapterEntry[];
}

/** Version 1 sidecar manifest shape (design anchor — not validated at runtime). */
export type GatherBoxSourceSidecar = GatherBoxGallerySourceSidecar | GatherBoxStorySourceSidecar;
