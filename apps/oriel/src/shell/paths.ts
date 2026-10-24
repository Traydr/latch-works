/**
 * Path arithmetic for the window, which has no `node:path`. Paths come from the main process
 * absolute and resolved; Windows ones use backslashes.
 */

function separatorOf(target: string): "\\" | "/" {
  return target.includes("\\") ? "\\" : "/";
}

function trimEnd(target: string): string {
  return target.length > 1 ? target.replace(/[\\/]+$/, "") : target;
}

/** `target`'s place inside `folder` with `/` between names, "" for the folder itself, or null. */
export function relativeInside(folder: string, target: string): string | null {
  const root = trimEnd(folder);
  const inner = trimEnd(target);

  if (inner === root) {
    return "";
  }

  const prefix = root.endsWith(separatorOf(root)) ? root : `${root}${separatorOf(root)}`;

  return inner.startsWith(prefix) ? inner.slice(prefix.length).replaceAll("\\", "/") : null;
}

/** The last name in `target`: a file's name, or a folder's. */
export function baseName(target: string): string {
  const inner = trimEnd(target);

  return inner.slice(Math.max(inner.lastIndexOf("/"), inner.lastIndexOf("\\")) + 1) || inner;
}

/** The folder holding `target`; a root keeps its separator, as "/" or "C:\\". */
export function parentOf(target: string): string {
  const inner = trimEnd(target);
  const at = Math.max(inner.lastIndexOf("/"), inner.lastIndexOf("\\"));

  if (at < 0) {
    return inner;
  }

  return at === 0 || inner[at - 1] === ":" ? inner.slice(0, at + 1) : inner.slice(0, at);
}

/** The folder of `folders` that holds `target` most closely, if any. */
export function closestFolder<T extends { path: string }>(folders: readonly T[], target: string) {
  let best: T | null = null;

  for (const folder of folders) {
    if (
      relativeInside(folder.path, target) !== null &&
      folder.path.length > (best?.path.length ?? -1)
    ) {
      best = folder;
    }
  }

  return best;
}
