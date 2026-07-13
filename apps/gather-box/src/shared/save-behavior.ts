import type { SiteKey } from "./sites";

export type SavePattern = "nested" | "single-folder" | "direct-file";

export interface SaveBehavior {
  pattern: SavePattern;
  folderDepth: number;
  summary: string;
  detail: string;
  pathTemplate: string;
  filePattern: string;
  tag: string;
  railCode: string;
}

const NESTED_BEHAVIORS: Partial<Record<SiteKey, Omit<SaveBehavior, "pattern" | "railCode" | "tag">>> = {
  kemono: {
    folderDepth: 3,
    summary: "Creates 3 nested folders",
    detail: "Files nest by service, user, then post title under your chosen root.",
    pathTemplate: "<root>/<service>/<user>/<post title>/",
    filePattern: "Attachment filenames"
  },
  fanbox: {
    folderDepth: 2,
    summary: "Creates 2 nested folders",
    detail: "Files nest by creator, then post title + ID under your chosen root.",
    pathTemplate: "<root>/<creator>/<post title>-<id>/",
    filePattern: "CDN filenames (jpg / png / webp / gif)"
  }
};

const SINGLE_FOLDER_BEHAVIORS: Partial<Record<SiteKey, Omit<SaveBehavior, "pattern" | "railCode" | "tag">>> = {
  myhentaigallery: {
    folderDepth: 1,
    summary: "Creates 1 folder",
    detail: "Images save into a single folder named after the comic.",
    pathTemplate: "<root>/<comic title>/",
    filePattern: "Original filenames (webp / jpg)"
  },
  x: {
    folderDepth: 1,
    summary: "Creates 1 creator folder",
    detail: "Media saves under the post author's username.",
    pathTemplate: "<root>/<username>/",
    filePattern: "X media filenames"
  },
  pixiv: {
    folderDepth: 1,
    summary: "Creates 1 creator folder",
    detail: "Images save under the creator name and pixiv user ID.",
    pathTemplate: "<root>/<username>-<user id>/",
    filePattern: "pixiv original filenames"
  }
};

const DIRECT_FILE_BEHAVIORS: Partial<Record<SiteKey, Omit<SaveBehavior, "pattern" | "railCode" | "tag">>> = {
  archiveofourown: {
    folderDepth: 0,
    summary: "Saves directly to root",
    detail: "No folder is created. One PDF lands in your chosen root.",
    pathTemplate: "<root>/",
    filePattern: "Author-Story.pdf (site-generated)"
  },
  "hentaifoundry-stories": {
    folderDepth: 0,
    summary: "Saves directly to root",
    detail: "No folder is created. One PDF lands in your chosen root.",
    pathTemplate: "<root>/",
    filePattern: "Author-Story.pdf (site-generated)"
  },
  "fanfiction-net": {
    folderDepth: 0,
    summary: "Saves directly to root",
    detail: "No folder is created. All chapters are fetched, merged, and saved as one PDF in your chosen root.",
    pathTemplate: "<root>/",
    filePattern: "Author-Story.pdf (generated locally)"
  }
};

const SAVE_BEHAVIORS: Record<SiteKey, SaveBehavior> = buildSaveBehaviors();

export function getSaveBehavior(siteKey: SiteKey | null): SaveBehavior | null {
  if (!siteKey) {
    return null;
  }

  return SAVE_BEHAVIORS[siteKey] ?? null;
}

export function getAllSaveBehaviors(): Array<SaveBehavior & { siteKey: SiteKey }> {
  return (Object.keys(SAVE_BEHAVIORS) as SiteKey[]).map((siteKey) => ({
    siteKey,
    ...SAVE_BEHAVIORS[siteKey]
  }));
}

function buildSaveBehaviors(): Record<SiteKey, SaveBehavior> {
  const entries = Object.entries(
    mergePartial(NESTED_BEHAVIORS, SINGLE_FOLDER_BEHAVIORS, DIRECT_FILE_BEHAVIORS)
  ) as Array<[SiteKey, Omit<SaveBehavior, "pattern" | "railCode" | "tag">]>;

  const result = {} as Record<SiteKey, SaveBehavior>;

  for (const [siteKey, behavior] of entries) {
    const pattern = resolvePattern(siteKey);
    result[siteKey] = {
      ...behavior,
      pattern,
      railCode: buildRailCode(pattern, behavior.folderDepth),
      tag: buildTag(pattern, behavior.folderDepth)
    };
  }

  return result;
}

function resolvePattern(siteKey: SiteKey): SavePattern {
  if (siteKey in NESTED_BEHAVIORS) {
    return "nested";
  }

  if (siteKey in SINGLE_FOLDER_BEHAVIORS) {
    return "single-folder";
  }

  return "direct-file";
}

function buildRailCode(pattern: SavePattern, depth: number): string {
  if (pattern === "nested") {
    return `N${depth}`;
  }

  if (pattern === "single-folder") {
    return "F1";
  }

  return "D";
}

function buildTag(pattern: SavePattern, depth: number): string {
  if (pattern === "nested") {
    return `NESTED · ${depth}`;
  }

  if (pattern === "single-folder") {
    return "FOLDER · 1";
  }

  return "DIRECT";
}

function mergePartial(
  ...sources: Array<Partial<Record<SiteKey, Omit<SaveBehavior, "pattern" | "railCode" | "tag">>>>
): Partial<Record<SiteKey, Omit<SaveBehavior, "pattern" | "railCode" | "tag">>> {
  const merged: Partial<Record<SiteKey, Omit<SaveBehavior, "pattern" | "railCode" | "tag">>> = {};

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      merged[key as SiteKey] = value;
    }
  }

  return merged;
}
