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

export function normalizePathForCompare(path: string): string {
  return trimTrailingSlash(toArchivePath(path)).toLowerCase();
}

export function displayNameFromPath(path: string): string {
  return getBaseName(path).replace(/[_-]/g, " ");
}
