import { GATHER_SOURCES, getGatherSourceFromUrl } from "./source-catalog";

export type { SiteKey } from "./source-catalog";

export const SUPPORTED_SITES = GATHER_SOURCES;

export function isSupportedUrl(url: string): boolean {
  return getGatherSourceFromUrl(url) !== null;
}

export function getSiteKeyFromUrl(url: string) {
  return getGatherSourceFromUrl(url)?.key ?? null;
}
