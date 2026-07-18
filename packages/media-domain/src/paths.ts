export function toArchivePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

export function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

export function getParentPath(path: string): string {
  const normalized = trimTrailingSlash(toArchivePath(path));
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex < 0) {
    return "";
  }

  return normalized.slice(0, separatorIndex);
}

export function getBaseName(path: string): string {
  const normalized = trimTrailingSlash(toArchivePath(path));
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

export function joinArchivePath(...parts: string[]): string {
  return toArchivePath(parts.filter(Boolean).join("/"));
}

/** Alias map so equivalent spellings share one sync/storage identity. */
const EXTENSION_ALIASES: Record<string, string> = {
  jpeg: "jpg",
};

export function canonicalizeExtension(extension: string): string {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  return EXTENSION_ALIASES[normalized] ?? normalized;
}

/**
 * Identity key for sync/plan matching.
 * Fold separators, Unicode (NFC), case, and extension aliases (jpeg → jpg).
 */
export function normalizePathForCompare(path: string): string {
  const normalized = trimTrailingSlash(toArchivePath(path)).normalize("NFC").toLowerCase();
  return canonicalizePathExtension(normalized);
}

function canonicalizePathExtension(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  const baseStart = separatorIndex + 1;
  const baseName = path.slice(baseStart);
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) {
    return path;
  }

  const extension = baseName.slice(dotIndex + 1);
  const canonicalExtension = canonicalizeExtension(extension);
  if (canonicalExtension === extension) {
    return path;
  }

  return `${path.slice(0, baseStart)}${baseName.slice(0, dotIndex + 1)}${canonicalExtension}`;
}

export function displayNameFromPath(path: string): string {
  return getBaseName(path).replace(/[_-]/g, " ");
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / k ** i;
  const decimals = i === 0 ? 0 : 1;

  return `${value.toFixed(decimals)} ${sizes[i]}`;
}
