export type MediaScope =
  | { mode: "all" }
  | { mode: "direct-children"; parentPath: string }
  | { mode: "search" }
  | { mode: "subtree"; pathPrefix: string };

export function resolveMediaScope({
  currentPath,
  recursive,
  searching,
}: {
  currentPath: string;
  recursive: boolean;
  searching: boolean;
}): MediaScope {
  if (searching) {
    return { mode: "search" };
  }

  if (recursive) {
    if (currentPath) {
      return { mode: "subtree", pathPrefix: currentPath };
    }

    return { mode: "all" };
  }

  return { mode: "direct-children", parentPath: currentPath };
}

export function escapeLikePatternForTest(value: string): string {
  return escapeLikePattern(value);
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
