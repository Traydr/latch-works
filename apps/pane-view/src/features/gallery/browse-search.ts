import { getParentPath as getArchiveParentPath } from "@latch-works/media-domain";
import { z } from "zod";

/** A free-text search param: trimmed, and absent when empty or not a string. */
const searchTextSchema = z.string().trim().min(1).optional().catch(undefined);

/** A flag search param: JSON booleans as well as the "true"/"1"/"false"/"0" URL spellings. */
const searchFlagSchema = z
  .union([
    z.boolean(),
    z.enum(["true", "1"]).transform(() => true),
    z.enum(["false", "0"]).transform(() => false),
  ])
  .optional()
  .catch(undefined);

/** The gallery route's `validateSearch` contract; anything malformed is dropped, never rejected. */
export const GalleryBrowseSearchSchema = z.object({
  comic: searchFlagSchema,
  media: searchTextSchema,
  path: searchTextSchema,
  q: searchTextSchema,
  recursive: searchFlagSchema,
});

export type GalleryBrowseSearch = z.infer<typeof GalleryBrowseSearchSchema>;

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
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}
