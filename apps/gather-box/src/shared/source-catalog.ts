import sourceCatalogData from "../../source-catalog.json";

export type SiteKey =
  | "myhentaigallery"
  | "kemono"
  | "fanbox"
  | "x"
  | "reddit"
  | "pixiv"
  | "archiveofourown"
  | "hentaifoundry-stories"
  | "hentaifoundry-pictures"
  | "fanfiction-net";

export type GatherOutputKind = "downloadable-files" | "generated-story-pdf";
export type SavePattern = "nested" | "single-folder" | "direct-file" | "conditional";

export interface SourceSaveBehavior {
  pattern: SavePattern;
  folderDepth: number;
  summary: string;
  detail: string;
  pathTemplate: string;
  filePattern: string;
  tag: string;
  railCode: string;
}

export interface GatherSource {
  key: SiteKey;
  label: string;
  /**
   * Unlisted sources work exactly like listed ones — they are only kept out of
   * enumerated surfaces (the options page, generated docs, the site appendix).
   * Runtime status and error messages still name them once you are on the page.
   */
  unlisted?: boolean;
  urlPatterns: readonly RegExp[];
  pageMatches: readonly string[];
  hostPermissions: readonly { pattern: string; reason: string }[];
  contextMenuMatches: readonly string[];
  collectorEntry: string;
  collectorModule: string;
  outputKinds: readonly GatherOutputKind[];
  includeCredentialsByDefault: boolean;
  downloadUrlPatterns: readonly RegExp[];
  save: SourceSaveBehavior;
}

interface SerializedGatherSource extends Omit<GatherSource, "urlPatterns" | "downloadUrlPatterns"> {
  urlPatterns: string[];
  downloadUrlPatterns: string[];
}

export const GATHER_SOURCES: readonly GatherSource[] = (
  sourceCatalogData as SerializedGatherSource[]
).map((source) => ({
  ...source,
  urlPatterns: source.urlPatterns.map((pattern) => new RegExp(pattern, "i")),
  downloadUrlPatterns: source.downloadUrlPatterns.map((pattern) => new RegExp(pattern, "i"))
}));

/** Sources safe to enumerate in UI and docs. Use this for any browsable list. */
export const LISTED_GATHER_SOURCES: readonly GatherSource[] = GATHER_SOURCES.filter(
  (source) => !source.unlisted
);

const SOURCES_BY_KEY = new Map(GATHER_SOURCES.map((source) => [source.key, source]));

export function getGatherSource(siteKey: unknown): GatherSource | null {
  return typeof siteKey === "string" ? (SOURCES_BY_KEY.get(siteKey as SiteKey) ?? null) : null;
}

export function getGatherSourceFromUrl(url: string): GatherSource | null {
  return (
    GATHER_SOURCES.find((source) => source.urlPatterns.some((pattern) => pattern.test(url))) ?? null
  );
}

export function getContextMenuMatches(): string[] {
  return [...new Set(GATHER_SOURCES.flatMap((source) => source.contextMenuMatches))].sort();
}
