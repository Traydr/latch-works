import type { DownloadablePayload, GeneratedStoryPayload } from "./types";

export function lowercaseFirstAscii(value: string): string {
  const first = value.charAt(0);

  return first >= "A" && first <= "Z" ? `${first.toLowerCase()}${value.slice(1)}` : value;
}

export function sanitizePathSegment(value: string): string {
  const raw = value.trim();

  if (raw === "." || raw === "..") {
    return "";
  }

  const sanitized = raw
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, "_")
    // Trailing dots are Windows-invalid; keep trailing underscores (X handles).
    .replace(/\.+$/g, "")
    .trim();

  if (sanitized === "." || sanitized === "..") {
    return "";
  }

  return sanitized || "";
}

export function sanitizeFileName(value: string): string {
  const sanitized = value
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

  const titleSegment = sanitizePathSegment(payload.title || "comic");

  return titleSegment ? [titleSegment] : ["comic"];
}

/**
 * Moves a multi-image X post into a folder named after the post ID and prefixes each file with
 * its position in the post (`01_`, `02_`, ...), so the post's order survives on disk. Single-image
 * posts and other sites pass through unchanged.
 */
export function groupXPostInFolder(payload: DownloadablePayload): DownloadablePayload {
  if (payload.site !== "x" || !payload.galleryId || payload.images.length < 2) {
    return payload;
  }

  const width = Math.max(2, String(payload.images.length).length);

  return {
    ...payload,
    folderSegments: [...payload.folderSegments, payload.galleryId],
    images: payload.images.map((image, index) => ({
      ...image,
      fileName: `${String(index + 1).padStart(width, "0")}_${image.fileName}`
    }))
  };
}

export function buildFolderPreview(rootName: string, segments: string[]): string {
  return segments.length > 0 ? `${rootName}/${segments.join("/")}` : rootName;
}
