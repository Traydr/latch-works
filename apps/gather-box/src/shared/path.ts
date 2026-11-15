/** The URL's last path segment, decoded; empty when there is none. */
export function getUrlFileName(url: string): string {
  const segment = new URL(url).pathname.split("/").pop() ?? "";

  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function lowercaseFirstAscii(value: string): string {
  const first = value.charAt(0);

  return first >= "A" && first <= "Z" ? `${first.toLowerCase()}${value.slice(1)}` : value;
}

/** Characters Windows or Chrome's File System Access refuse anywhere in a name. */
const UNSAFE_NAME_CHARACTERS = /[<>:"/\\|?*\p{Cc}]/gu;

/**
 * Invisible characters Chrome also refuses anywhere in a name: format characters such as
 * zero-width joiners, and Unicode non-characters. They are deleted rather than replaced, after
 * whitespace (which includes U+FEFF) has become "_", so names Chrome already accepted keep theirs.
 */
const INVISIBLE_NAME_CHARACTERS = /[\p{Cf}\p{Noncharacter_Code_Point}]/gu;

export function sanitizePathSegment(value: string): string {
  const raw = value.trim();

  if (raw === "." || raw === "..") {
    return "";
  }

  const sanitized = raw
    .replace(UNSAFE_NAME_CHARACTERS, " ")
    .replace(/\s+/g, "_")
    .replace(INVISIBLE_NAME_CHARACTERS, "")
    // Chrome sets aside one leading "." (".git" is allowed), then refuses a name that starts or
    // ends with "." or "~" ("Name is not allowed"). Trailing underscores stay (X handles).
    .replace(/^~+/, "")
    .replace(/^\.[.~]+/, "")
    .replace(/[.~]+$/, "")
    .trim();

  if (sanitized === "." || sanitized === "..") {
    return "";
  }

  return sanitized;
}

export function sanitizeFileName(value: string): string {
  const sanitized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(UNSAFE_NAME_CHARACTERS, " ")
    .replace(/\s+/g, "_")
    .replace(INVISIBLE_NAME_CHARACTERS, "")
    .replace(/_+/g, "_")
    .replace(/^[._~]+|[._~]+$/g, "")
    .trim();

  return sanitized || "";
}

export function buildStoryPdfFileName(author: string, title: string): string {
  const authorPart = sanitizeFileName(author);
  const titlePart = sanitizeFileName(title);
  const baseName = [authorPart, titlePart].filter(Boolean).join("-");

  return `${baseName || "story"}.pdf`;
}

/** Folder segments made safe for the file system, with any left empty dropped. */
export function sanitizeFolderSegments(segments: readonly string[]): string[] {
  return segments.flatMap((segment) => {
    const sanitized = sanitizePathSegment(segment);

    return sanitized ? [sanitized] : [];
  });
}

/**
 * Prefixes each file with its position (`01_`, `02_`, ...), so a post's order survives on disk.
 */
export function numberFileNames<File extends { fileName: string }>(files: readonly File[]): File[] {
  const width = Math.max(2, String(files.length).length);

  return files.map((file, index) => ({
    ...file,
    fileName: `${String(index + 1).padStart(width, "0")}_${file.fileName}`,
  }));
}

export function buildFolderPreview(rootName: string, segments: string[]): string {
  return segments.length > 0 ? `${rootName}/${segments.join("/")}` : rootName;
}
