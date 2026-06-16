import { getParentPath as getArchiveParentPath } from "@latch-works/media-domain";

export interface GalleryBrowseSearch {
  comic?: boolean;
  media?: string;
  path?: string;
  q?: string;
  recursive?: boolean;
}

export function parseGalleryBrowseSearch(search: Record<string, unknown>): GalleryBrowseSearch {
  return {
    comic: normalizeBooleanSearchParam(search.comic),
    media: normalizeSearchParam(search.media),
    path: normalizeSearchParam(search.path),
    q: normalizeSearchParam(search.q),
    recursive: normalizeBooleanSearchParam(search.recursive),
  };
}

export function normalizeSearchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeBooleanSearchParam(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "1") {
    return true;
  }

  if (value === false || value === "false" || value === "0") {
    return false;
  }

  return undefined;
}

export function displayPathFromSearch(path: string | undefined): string {
  return path ?? "";
}

export function canUseFolderBrowseModes(path: string | undefined): boolean {
  return displayPathFromSearch(path) !== "";
}

export function buildBreadcrumbItems(path: string): Array<{ label: string; path: string }> {
  if (!path) {
    return [{ label: "Archive root", path: "" }];
  }

  const segments = path.split("/").filter(Boolean);
  return segments.map((segment, index) => ({
    label: segment,
    path: segments.slice(0, index + 1).join("/"),
  }));
}

export function getParentPath(path: string): string {
  return getArchiveParentPath(path);
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    !!element &&
    (element.isContentEditable ||
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT")
  );
}
