import * as z from "zod/mini";
import { SITE_KEYS } from "./source-catalog";

export const SiteKeySchema = z.enum(SITE_KEYS);

export const DownloadableFileSchema = z.object({
  originalUrl: z.string(),
  fileName: z.string(),
});

export type DownloadableFile = z.infer<typeof DownloadableFileSchema>;

const DownloadablePayloadSchema = z.object({
  ok: z.literal(true),
  outputKind: z.literal("downloadable-files"),
  site: SiteKeySchema,
  title: z.string(),
  pageUrl: z.string(),
  galleryId: z.nullable(z.string()),
  folderSegments: z.array(z.string()),
  images: z.array(DownloadableFileSchema),
});

export type DownloadablePayload = z.infer<typeof DownloadablePayloadSchema>;

const StoryChapterReferenceSchema = z.object({
  chapterNumber: z.number(),
  label: z.string(),
  url: z.string(),
});

export type StoryChapterReference = z.infer<typeof StoryChapterReferenceSchema>;

const GeneratedStoryPayloadSchema = z.object({
  ok: z.literal(true),
  outputKind: z.literal("generated-story-pdf"),
  site: SiteKeySchema,
  title: z.string(),
  author: z.string(),
  pageUrl: z.string(),
  storyId: z.string(),
  folderSegments: z.array(z.string()),
  fileName: z.string(),
  summary: z.string(),
  metadataLine: z.string(),
  chapters: z.array(StoryChapterReferenceSchema),
});

export type GeneratedStoryPayload = z.infer<typeof GeneratedStoryPayloadSchema>;

export const GatherOutputSchema = z.union([DownloadablePayloadSchema, GeneratedStoryPayloadSchema]);

export type GatherOutput = z.infer<typeof GatherOutputSchema>;

const CollectionErrorSchema = z.object({ ok: z.literal(false), message: z.string() });

type CollectionError = z.infer<typeof CollectionErrorSchema>;

export const CollectionResultSchema = z.union([GatherOutputSchema, CollectionErrorSchema]);

export type CollectionResult = z.infer<typeof CollectionResultSchema>;

/** What a collector returns; its entry adds the source key and page URL it was installed for. */
export type CollectorResult =
  | Omit<DownloadablePayload, "site" | "pageUrl">
  | Omit<GeneratedStoryPayload, "site" | "pageUrl">
  | CollectionError;
