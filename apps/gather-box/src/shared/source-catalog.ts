import { z } from "zod";
import sourceCatalogData from "../../source-catalog.json";

export const SiteKeySchema = z.enum([
  "myhentaigallery",
  "kemono",
  "fanbox",
  "x",
  "reddit",
  "pixiv",
  "archiveofourown",
  "hentaifoundry-stories",
  "hentaifoundry-pictures",
  "danbooru",
  "fanfiction-net"
]);

export type SiteKey = z.infer<typeof SiteKeySchema>;

export const GatherOutputKindSchema = z.enum(["downloadable-files", "generated-story-pdf"]);
export type GatherOutputKind = z.infer<typeof GatherOutputKindSchema>;

const SavePatternSchema = z.enum(["nested", "single-folder", "direct-file", "conditional"]);
export type SavePattern = z.infer<typeof SavePatternSchema>;

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

/** `source-catalog.json` as it sits on disk: URL patterns are still regex source strings. */
const SerializedGatherSourceSchema = z.object({
  key: SiteKeySchema,
  label: z.string(),
  unlisted: z.boolean().optional(),
  urlPatterns: z.array(z.string()),
  pageMatches: z.array(z.string()),
  hostPermissions: z.array(z.object({ pattern: z.string(), reason: z.string() })),
  contextMenuMatches: z.array(z.string()),
  collectorEntry: z.string(),
  collectorModule: z.string(),
  outputKinds: z.array(GatherOutputKindSchema),
  includeCredentialsByDefault: z.boolean(),
  downloadUrlPatterns: z.array(z.string()),
  save: z.object({
    pattern: SavePatternSchema,
    folderDepth: z.number(),
    summary: z.string(),
    detail: z.string(),
    pathTemplate: z.string(),
    filePattern: z.string(),
    tag: z.string(),
    railCode: z.string()
  })
});

export const GATHER_SOURCES: readonly GatherSource[] = z
  .array(SerializedGatherSourceSchema)
  .parse(sourceCatalogData)
  .map((source) => ({
    ...source,
    urlPatterns: source.urlPatterns.map((pattern) => new RegExp(pattern, "i")),
    downloadUrlPatterns: source.downloadUrlPatterns.map((pattern) => new RegExp(pattern, "i"))
  }));

/** Sources safe to enumerate in UI and docs. Use this for any browsable list. */
export const LISTED_GATHER_SOURCES: readonly GatherSource[] = GATHER_SOURCES.filter(
  (source) => !source.unlisted
);

const SOURCES_BY_KEY = new Map<string, GatherSource>(
  GATHER_SOURCES.map((source) => [source.key, source])
);

export function getGatherSource(siteKey: string): GatherSource | null {
  return SOURCES_BY_KEY.get(siteKey) ?? null;
}

export function getGatherSourceFromUrl(url: string): GatherSource | null {
  return (
    GATHER_SOURCES.find((source) => source.urlPatterns.some((pattern) => pattern.test(url))) ?? null
  );
}

export function getContextMenuMatches(): string[] {
  return [...new Set(GATHER_SOURCES.flatMap((source) => source.contextMenuMatches))].sort();
}
