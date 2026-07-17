import type { GatherBoxSettings } from "./settings";
import type { SiteKey } from "./sites";
import { getGatherSource } from "./source-catalog";

export function shouldIncludeCredentials(
  payload: { site: SiteKey },
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
    return choice
      ? choice === "include"
      : (getGatherSource(payload.site)?.includeCredentialsByDefault ?? false);
  }

  return getGatherSource(payload.site)?.includeCredentialsByDefault ?? false;
}
