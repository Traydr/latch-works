import type { SiteKey } from "./sites";

export type PrimaryUiMode = "popup" | "sidePanel";
export type CredentialsMode = "auto" | "always" | "never" | "perSite";
export type CredentialsChoice = "include" | "omit";

export interface GatherBoxSettings {
  downloadConcurrency: number;
  skipExistingFiles: boolean;
  useGlobalFolder: boolean;
  verboseLogging: boolean;
  credentialsMode: CredentialsMode;
  credentialsPerSite: Partial<Record<SiteKey, CredentialsChoice>>;
  primaryUi: PrimaryUiMode;
}

export const DEFAULT_SETTINGS: GatherBoxSettings = {
  downloadConcurrency: 4,
  skipExistingFiles: false,
  useGlobalFolder: false,
  verboseLogging: false,
  credentialsMode: "auto",
  credentialsPerSite: {},
  primaryUi: "popup"
};

const SETTINGS_KEY = "gather-box-settings";

export async function loadSettings(): Promise<GatherBoxSettings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY];

  if (!value || typeof value !== "object") {
    return { ...DEFAULT_SETTINGS };
  }

  return normalizeSettings(value as Partial<GatherBoxSettings>);
}

export async function saveSettings(settings: GatherBoxSettings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
}

export function normalizeSettings(settings: Partial<GatherBoxSettings>): GatherBoxSettings {
  const concurrency = Number(settings.downloadConcurrency ?? DEFAULT_SETTINGS.downloadConcurrency);

  return {
    downloadConcurrency: Number.isFinite(concurrency)
      ? Math.min(16, Math.max(1, Math.round(concurrency)))
      : DEFAULT_SETTINGS.downloadConcurrency,
    skipExistingFiles: Boolean(settings.skipExistingFiles),
    useGlobalFolder: Boolean(settings.useGlobalFolder),
    verboseLogging: Boolean(settings.verboseLogging),
    credentialsMode: isCredentialsMode(settings.credentialsMode)
      ? settings.credentialsMode
      : DEFAULT_SETTINGS.credentialsMode,
    credentialsPerSite: sanitizeCredentialsPerSite(settings.credentialsPerSite),
    primaryUi: settings.primaryUi === "sidePanel" ? "sidePanel" : "popup"
  };
}

function isCredentialsMode(value: unknown): value is CredentialsMode {
  return value === "auto" || value === "always" || value === "never" || value === "perSite";
}

function sanitizeCredentialsPerSite(
  value: Partial<Record<SiteKey, CredentialsChoice>> | undefined
): Partial<Record<SiteKey, CredentialsChoice>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const sanitized: Partial<Record<SiteKey, CredentialsChoice>> = {};

  for (const [siteKey, choice] of Object.entries(value)) {
    if (choice === "include" || choice === "omit") {
      sanitized[siteKey as SiteKey] = choice;
    }
  }

  return sanitized;
}
