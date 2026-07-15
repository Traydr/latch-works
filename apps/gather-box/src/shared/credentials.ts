import type { GatherBoxSettings } from "./settings";
import { getGatherSource } from "./source-catalog";
import type { DownloadablePayload } from "./types";

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
    return choice
      ? choice === "include"
      : (getGatherSource(payload.site)?.includeCredentialsByDefault ?? false);
  }

  return getGatherSource(payload.site)?.includeCredentialsByDefault ?? false;
}
