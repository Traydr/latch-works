const STILL_IMAGE_EXTENSIONS = new Set(["bmp", "jpeg", "jpg", "png", "webp"]);

export type ArchiveMediaAction = "convert-avif" | "convert-mp4" | "rename-avif" | "rename-mp4";

export interface ArchiveMediaPlan {
  action: ArchiveMediaAction;
  fileName: string;
}

export function getExpectedArchiveTarget(fileName: string): string | null {
  return planFromExtension(fileName)?.fileName ?? null;
}

export function planArchiveMedia(fileName: string, mimeType: string): ArchiveMediaPlan | null {
  const extension = getFileExtension(fileName);
  const normalizedMimeType = mimeType.toLowerCase().split(";", 1)[0].trim();

  if (normalizedMimeType === "image/avif") {
    return extension === "avif"
      ? null
      : { action: "rename-avif", fileName: replaceFileExtension(fileName, "avif") };
  }
  if (normalizedMimeType === "video/mp4") {
    return extension === "mp4"
      ? null
      : { action: "rename-mp4", fileName: replaceFileExtension(fileName, "mp4") };
  }
  if (normalizedMimeType === "image/gif") {
    return { action: "convert-mp4", fileName: replaceFileExtension(fileName, "mp4") };
  }
  if (normalizedMimeType.startsWith("video/")) {
    return null;
  }
  if (normalizedMimeType.startsWith("image/") && normalizedMimeType !== "image/svg+xml") {
    return { action: "convert-avif", fileName: replaceFileExtension(fileName, "avif") };
  }

  return planFromExtension(fileName);
}

function planFromExtension(fileName: string): ArchiveMediaPlan | null {
  const extension = getFileExtension(fileName);
  if (extension === "gif") {
    return { action: "convert-mp4", fileName: replaceFileExtension(fileName, "mp4") };
  }
  if (STILL_IMAGE_EXTENSIONS.has(extension)) {
    return { action: "convert-avif", fileName: replaceFileExtension(fileName, "avif") };
  }
  return null;
}

function getFileExtension(fileName: string): string {
  const lastSegment = fileName.split(/[\\/]/).at(-1) ?? fileName;
  const dotIndex = lastSegment.lastIndexOf(".");
  return dotIndex > 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : "";
}

function replaceFileExtension(fileName: string, extension: string): string {
  const lastSlashIndex = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > lastSlashIndex + 1 ? fileName.slice(0, dotIndex) : fileName;
  return `${baseName}.${extension}`;
}
