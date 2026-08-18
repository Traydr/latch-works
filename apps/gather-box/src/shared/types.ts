import { z } from "zod";
import { SiteKeySchema } from "./source-catalog";

export const DownloadableFileSchema = z.object({
  pageNumber: z.number(),
  thumbnailUrl: z.string().nullable(),
  originalUrl: z.string(),
  fileName: z.string()
});

export type DownloadableFile = z.infer<typeof DownloadableFileSchema>;

export const GalleryImageSchema = DownloadableFileSchema;
export type GalleryImage = DownloadableFile;

export const DownloadablePayloadSchema = z.object({
  ok: z.literal(true),
  outputKind: z.literal("downloadable-files"),
  site: SiteKeySchema,
  title: z.string(),
  pageUrl: z.string(),
  galleryId: z.string().nullable(),
  folderSegments: z.array(z.string()),
  skippedCount: z.number(),
  images: z.array(GalleryImageSchema)
});

export type DownloadablePayload = z.infer<typeof DownloadablePayloadSchema>;

export type GalleryPayload = DownloadablePayload;

export const StoryChapterReferenceSchema = z.object({
  chapterNumber: z.number(),
  label: z.string(),
  url: z.string()
});

export type StoryChapterReference = z.infer<typeof StoryChapterReferenceSchema>;

export const GeneratedStoryPayloadSchema = z.object({
  ok: z.literal(true),
  outputKind: z.literal("generated-story-pdf"),
  site: z.literal("fanfiction-net"),
  title: z.string(),
  author: z.string(),
  pageUrl: z.string(),
  storyId: z.string(),
  folderSegments: z.array(z.string()),
  skippedCount: z.number(),
  fileName: z.string(),
  summary: z.string(),
  metadataLine: z.string(),
  chapters: z.array(StoryChapterReferenceSchema)
});

export type GeneratedStoryPayload = z.infer<typeof GeneratedStoryPayloadSchema>;

export const CollectionErrorCodeSchema = z.enum([
  "UNSUPPORTED_SITE",
  "GRID_NOT_FOUND",
  "NO_IMAGES_FOUND",
  "NO_VALID_IMAGES",
  "MEDIA_RESOLUTION_FAILED",
  "INVALID_KEMONO_PATH",
  "USER_NOT_FOUND",
  "TITLE_NOT_FOUND",
  "FILES_NOT_FOUND",
  "NO_FILES_FOUND",
  "NO_VALID_FILES",
  "PDF_LINK_NOT_FOUND",
  "AUTHOR_NOT_FOUND",
  "CHAPTERS_NOT_FOUND",
  "STORY_TEXT_NOT_FOUND",
  "PDF_GENERATION_FAILED",
  "COLLECTION_FAILED"
]);

export type CollectionErrorCode = z.infer<typeof CollectionErrorCodeSchema>;

export const GalleryErrorSchema = z.object({
  ok: z.literal(false),
  code: CollectionErrorCodeSchema,
  message: z.string()
});

export type GalleryError = z.infer<typeof GalleryErrorSchema>;

export const GalleryCollectResponseSchema = z.union([
  DownloadablePayloadSchema,
  GeneratedStoryPayloadSchema,
  GalleryErrorSchema
]);

export type GalleryCollectResponse = z.infer<typeof GalleryCollectResponseSchema>;
