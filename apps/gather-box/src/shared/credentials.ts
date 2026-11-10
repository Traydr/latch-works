import type { GatherBoxSettings } from "./settings";
import { getGatherSource, type SiteKey } from "./source-catalog";

/** Whether a source's requests carry your browser session cookies. */
export function requestCredentials(
  payload: { site: SiteKey },
  settings: GatherBoxSettings,
): RequestCredentials {
  if (settings.credentialsMode === "always") {
    return "include";
  }

  if (settings.credentialsMode === "never") {
    return "omit";
  }

  const choice =
    settings.credentialsMode === "perSite" ? settings.credentialsPerSite[payload.site] : undefined;

  if (choice) {
    return choice;
  }

  return getGatherSource(payload.site)?.includeCredentialsByDefault ? "include" : "omit";
}
