import type { GatherBoxSettings } from "./settings";
import type { SiteKey } from "./sites";
import type { DownloadablePayload } from "./types";

const AUTO_INCLUDE_SITES = new Set<SiteKey>([
  "archiveofourown",
  "fanbox",
  "pixiv",
  "hentaifoundry-stories"
]);

export function shouldIncludeCredentials(
  payload: DownloadablePayload,
  settings: GatherBoxSettings
): boolean {
  if (settings.credentialsMode === "always") {
    return true;
  }

  if (settings.credentialsMode === "never") {
    return false;
  }

  if (settings.credentialsMode === "perSite") {
    const choice = settings.credentialsPerSite[payload.site];
    return choice ? choice === "include" : AUTO_INCLUDE_SITES.has(payload.site);
  }

  return AUTO_INCLUDE_SITES.has(payload.site);
}
