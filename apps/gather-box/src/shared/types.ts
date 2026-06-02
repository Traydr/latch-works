import type { SiteKey } from "./sites";

export interface DownloadableFile {
  pageNumber: number;
  thumbnailUrl: string | null;
  originalUrl: string;
  fileName: string;
}

export type GalleryImage = DownloadableFile;

export interface DownloadablePayload {
  ok: true;
  outputKind: "downloadable-files";
  site: SiteKey;
  title: string;
  pageUrl: string;
  galleryId: string | null;
  folderSegments: string[];
  skippedCount: number;
  images: GalleryImage[];
}

export type GalleryPayload = DownloadablePayload;

export interface GeneratedStoryPayload {
  ok: true;
  outputKind: "generated-story-pdf";
  site: "fanfiction-net";
  title: string;
  author: string;
  pageUrl: string;
  storyId: string;
  folderSegments: string[];
  skippedCount: number;
  fileName: string;
  summary: string;
  metadataLine: string;
  chapters: StoryChapterReference[];
}

export interface StoryChapterReference {
  chapterNumber: number;
  label: string;
  url: string;
}

export interface GalleryError {
  ok: false;
  code: CollectionErrorCode;
  message: string;
}

export type GalleryCollectResponse = GalleryPayload | GeneratedStoryPayload | GalleryError;

export type CollectionErrorCode =
  | "UNSUPPORTED_SITE"
  | "GRID_NOT_FOUND"
  | "NO_IMAGES_FOUND"
  | "NO_VALID_IMAGES"
  | "INVALID_KEMONO_PATH"
  | "USER_NOT_FOUND"
  | "TITLE_NOT_FOUND"
  | "FILES_NOT_FOUND"
  | "NO_FILES_FOUND"
  | "NO_VALID_FILES"
  | "PDF_LINK_NOT_FOUND"
  | "AUTHOR_NOT_FOUND"
  | "CHAPTERS_NOT_FOUND"
  | "STORY_TEXT_NOT_FOUND"
  | "PDF_GENERATION_FAILED"
  | "COLLECTION_FAILED";
