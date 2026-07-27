import { GATHER_SOURCES, LISTED_GATHER_SOURCES, getGatherSourceFromUrl } from "./source-catalog";

export type { SiteKey } from "./source-catalog";

/** Every source the extension can collect from, including unlisted ones. */
export const SUPPORTED_SITES = GATHER_SOURCES;

/** Sources shown in browsable UI lists. Detection still uses SUPPORTED_SITES. */
export const LISTED_SITES = LISTED_GATHER_SOURCES;

export function isSupportedUrl(url: string): boolean {
  return getGatherSourceFromUrl(url) !== null;
}

export function getSiteKeyFromUrl(url: string) {
  return getGatherSourceFromUrl(url)?.key ?? null;
}
