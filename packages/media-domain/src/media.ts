import { z } from "zod";

export const ImageExtensions = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"] as const;

export const VideoExtensions = ["mp4", "webm", "mov", "mkv", "m4v"] as const;
export const PdfExtensions = ["pdf"] as const;

export const MediaTypeSchema = z.enum(["image", "gif", "video", "pdf", "unknown"]);
export type MediaType = z.infer<typeof MediaTypeSchema>;

export const GallerySortModeSchema = z.enum([
  "name-asc",
  "name-desc",
  "date-newest",
  "date-oldest",
  "random",
]);
export type GallerySortMode = z.infer<typeof GallerySortModeSchema>;

export const MediaItemSchema = z.object({
  id: z.string(),
  path: z.string(),
  parentPath: z.string(),
  name: z.string(),
  extension: z.string(),
  mediaType: MediaTypeSchema,
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  sha256: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  pageCount: z.number().int().positive().optional(),
  thumbnailUrl: z.string().optional(),
  originalUrl: z.string().optional(),
});
export type MediaItem = z.infer<typeof MediaItemSchema>;

export const FolderNodeSchema = z.object({
  path: z.string(),
  parentPath: z.string(),
  parentId: z.uuid().nullable().optional(),
  name: z.string(),
  hasChildren: z.boolean(),
  mediaCount: z.number().int().nonnegative(),
  folderCount: z.number().int().nonnegative(),
});
export type FolderNode = z.infer<typeof FolderNodeSchema>;

const imageExtensionSet = new Set<string>(ImageExtensions);
const videoExtensionSet = new Set<string>(VideoExtensions);
const pdfExtensionSet = new Set<string>(PdfExtensions);

export function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === fileName.length - 1) {
    return "";
  }

  return fileName.slice(dotIndex + 1).toLowerCase();
}

export function detectMediaType(fileName: string): MediaType {
  const extension = getExtension(fileName);

  if (extension === "gif") {
    return "gif";
  }

  if (imageExtensionSet.has(extension)) {
    return "image";
  }

  if (videoExtensionSet.has(extension)) {
    return "video";
  }

  if (pdfExtensionSet.has(extension)) {
    return "pdf";
  }

  return "unknown";
}

export function isSupportedMediaFile(fileName: string): boolean {
  return detectMediaType(fileName) !== "unknown";
}
