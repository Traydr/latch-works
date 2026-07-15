import {
  GATHER_SOURCES,
  getGatherSource,
  type SiteKey,
  type SourceSaveBehavior
} from "./source-catalog";

export type SaveBehavior = SourceSaveBehavior;
export type { SavePattern } from "./source-catalog";

export function getSaveBehavior(siteKey: SiteKey | null): SaveBehavior | null {
  return siteKey ? (getGatherSource(siteKey)?.save ?? null) : null;
}

export function getAllSaveBehaviors(): Array<SaveBehavior & { siteKey: SiteKey }> {
  return GATHER_SOURCES.map((source) => ({ siteKey: source.key, ...source.save }));
}
