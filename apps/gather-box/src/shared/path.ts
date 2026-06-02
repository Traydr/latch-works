import type { DownloadablePayload, GeneratedStoryPayload } from "./types";

export function sanitizePathSegment(value: unknown): string {
  const sanitized = String(value || "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/[._]+$/g, "")
    .trim();

  return sanitized || "";
}

export function sanitizeFileName(value: unknown): string {
  const sanitized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .trim();

  return sanitized || "";
}

export function buildStoryPdfFileName(author: string, title: string): string {
  const authorPart = sanitizeFileName(author);
  const titlePart = sanitizeFileName(title);
  const baseName = [authorPart, titlePart].filter(Boolean).join("-");

  return `${baseName || "story"}.pdf`;
}

export function getFolderSegments(payload: DownloadablePayload | GeneratedStoryPayload): string[] {
  if (Array.isArray(payload.folderSegments)) {
    return payload.folderSegments.map(sanitizePathSegment).filter(Boolean);
  }

  const segments = [payload.title || "comic"].map(sanitizePathSegment).filter(Boolean);

  return segments.length > 0 ? segments : ["comic"];
}

export function buildFolderPreview(rootName: string, segments: string[]): string {
  return segments.length > 0 ? `${rootName}/${segments.join("/")}` : rootName;
}
