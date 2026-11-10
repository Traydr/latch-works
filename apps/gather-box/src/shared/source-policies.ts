import type { GatherBoxSettings } from "./settings";
import { getGatherSource, type SiteKey, type SourceSaveBehavior } from "./source-catalog";
import { HENTAI_FOUNDRY_PICTURES_POLICY } from "./sources/hentaifoundry-pictures";
import { X_POLICY } from "./sources/x";
import type { DownloadablePayload, GatherOutput } from "./types";

/** Source behavior that is code rather than catalog data. Every hook is optional. */
export interface GatherSourcePolicy {
  /** Rewrites a collected file batch in the background, before it is queued. */
  prepareOutput?(payload: DownloadablePayload, settings: GatherBoxSettings): DownloadablePayload;
  /** The save path the side panel shows, for a source whose path depends on settings. */
  describeSave?(save: SourceSaveBehavior, settings: GatherBoxSettings): SourceSaveBehavior;
  /**
   * The folder name an older build used for this standard one. The executor writes into it
   * instead when such a folder already exists, so an artist does not end up with two folders.
   */
  legacyFolderName?(folder: string): string | null;
}

const POLICIES: Partial<Record<SiteKey, GatherSourcePolicy>> = {
  x: X_POLICY,
  "hentaifoundry-pictures": HENTAI_FOUNDRY_PICTURES_POLICY,
};

export function getSourcePolicy(siteKey: SiteKey): GatherSourcePolicy {
  return POLICIES[siteKey] ?? {};
}

export function prepareGatherOutput(
  output: GatherOutput,
  settings: GatherBoxSettings,
): GatherOutput {
  const prepare = getSourcePolicy(output.site).prepareOutput;

  return prepare && output.outputKind === "downloadable-files" ? prepare(output, settings) : output;
}

export function describeSaveBehavior(
  siteKey: SiteKey | null,
  settings: GatherBoxSettings,
): SourceSaveBehavior | null {
  const source = siteKey ? getGatherSource(siteKey) : null;

  if (!source) {
    return null;
  }

  return getSourcePolicy(source.key).describeSave?.(source.save, settings) ?? source.save;
}
