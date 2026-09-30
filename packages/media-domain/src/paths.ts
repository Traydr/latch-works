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
const EXTENSION_ALIASES = new Map([["jpeg", "jpg"]]);

export function canonicalizeExtension(extension: string): string {
  const normalized = extension.replace(/^\./, "").toLowerCase();

  return EXTENSION_ALIASES.get(normalized) ?? normalized;
}

/**
 * Identity key for sync/plan matching.
 * Fold separators, Unicode (NFC), case, and optionally extension aliases (jpeg → jpg).
 */
export function normalizePathForCompare(
  path: string,
  options: { canonicalizeExtensions?: boolean } = {},
): string {
  const normalized = trimTrailingSlash(toArchivePath(path)).normalize("NFC").toLowerCase();

  if (options.canonicalizeExtensions === false) {
    return normalized;
  }

  return canonicalizePathExtension(normalized);
}

/**
 * Pair local archive paths with the remote library paths they sync to.
 *
 * The server keys library entries by exact path, so exact matches pair first. Paths left over
 * then pair across spellings, case and Unicode (NFC) first and the jpeg↔jpg alias last, but only
 * when exactly one leftover local and one leftover remote share the key. A key several paths
 * could claim (e.g. `Photo.jpg` and `photo.jpg` on a case-sensitive archive) pairs nothing, so a
 * local file never updates a remote entry that belongs to a different file.
 *
 * Returns local path → remote path for every paired local path.
 */
export function pairSyncPaths(
  localPaths: readonly string[],
  remotePaths: readonly string[],
): Map<string, string> {
  const pairs = new Map<string, string>();
  const pairedRemotes = new Set<string>();

  const identities: Array<(path: string) => string> = [
    (path) => trimTrailingSlash(toArchivePath(path)),
    (path) => normalizePathForCompare(path, { canonicalizeExtensions: false }),
    (path) => normalizePathForCompare(path),
  ];

  for (const identity of identities) {
    const groups = new Map<string, { locals: string[]; remotes: string[] }>();

    const groupFor = (key: string) => {
      let group = groups.get(key);

      if (!group) {
        group = { locals: [], remotes: [] };
        groups.set(key, group);
      }

      return group;
    };

    for (const path of localPaths) {
      if (!pairs.has(path)) {
        groupFor(identity(path)).locals.push(path);
      }
    }

    for (const path of remotePaths) {
      if (!pairedRemotes.has(path)) {
        groupFor(identity(path)).remotes.push(path);
      }
    }

    for (const { locals, remotes } of groups.values()) {
      const [local] = locals;
      const [remote] = remotes;

      if (
        locals.length === 1 &&
        remotes.length === 1 &&
        local !== undefined &&
        remote !== undefined
      ) {
        pairs.set(local, remote);
        pairedRemotes.add(remote);
      }
    }
  }

  return pairs;
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
