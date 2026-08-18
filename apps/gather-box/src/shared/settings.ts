import { z } from "zod";
import type { SiteKey } from "./sites";
import { getGatherSource } from "./source-catalog";

export const CredentialsModeSchema = z.enum(["auto", "always", "never", "perSite"]);
export type CredentialsMode = z.infer<typeof CredentialsModeSchema>;

export const CredentialsChoiceSchema = z.enum(["include", "omit"]);
export type CredentialsChoice = z.infer<typeof CredentialsChoiceSchema>;

export interface GatherBoxSettings {
  downloadConcurrency: number;
  mediaCompatibilityMode: boolean;
  useGlobalFolder: boolean;
  verboseLogging: boolean;
  pageShortcutsEnabled: boolean;
  credentialsMode: CredentialsMode;
  credentialsPerSite: Partial<Record<SiteKey, CredentialsChoice>>;
}

export const DEFAULT_SETTINGS: GatherBoxSettings = {
  downloadConcurrency: 4,
  mediaCompatibilityMode: false,
  useGlobalFolder: false,
  verboseLogging: false,
  pageShortcutsEnabled: true,
  credentialsMode: "auto",
  credentialsPerSite: {}
};

/**
 * Settings survive extension upgrades, so no field can reject the record: each one falls back to
 * its default. `shortcutsEnabled` is the pre-rename name of `pageShortcutsEnabled` and is only
 * consulted when the current name is absent.
 */
export const GatherBoxSettingsSchema = z
  .object({
    downloadConcurrency: z.coerce
      .number()
      .catch(DEFAULT_SETTINGS.downloadConcurrency)
      .transform((value) => Math.min(16, Math.max(1, Math.round(value)))),
    mediaCompatibilityMode: z.coerce.boolean().catch(false),
    useGlobalFolder: z.coerce.boolean().catch(false),
    verboseLogging: z.coerce.boolean().catch(false),
    pageShortcutsEnabled: z.coerce.boolean().optional(),
    shortcutsEnabled: z.coerce.boolean().optional(),
    credentialsMode: CredentialsModeSchema.catch(DEFAULT_SETTINGS.credentialsMode),
    credentialsPerSite: z
      .record(z.string(), CredentialsChoiceSchema.nullable().catch(null))
      .catch({})
  })
  .transform(
    (stored): GatherBoxSettings => ({
      downloadConcurrency: stored.downloadConcurrency,
      mediaCompatibilityMode: stored.mediaCompatibilityMode,
      useGlobalFolder: stored.useGlobalFolder,
      verboseLogging: stored.verboseLogging,
      pageShortcutsEnabled:
        stored.pageShortcutsEnabled ??
        stored.shortcutsEnabled ??
        DEFAULT_SETTINGS.pageShortcutsEnabled,
      credentialsMode: stored.credentialsMode,
      credentialsPerSite: keepKnownSources(stored.credentialsPerSite)
    })
  )
  .catch(() => ({ ...DEFAULT_SETTINGS, credentialsPerSite: {} }));

export const SETTINGS_KEY = "gather-box-settings";

export async function loadSettings(): Promise<GatherBoxSettings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);

  return GatherBoxSettingsSchema.parse(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: GatherBoxSettings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: GatherBoxSettingsSchema.parse(settings) });
}

/** Per-site overrides for sources the catalog no longer lists are dropped on read. */
function keepKnownSources(choices: Record<string, CredentialsChoice | null>) {
  const known: Partial<Record<SiteKey, CredentialsChoice>> = {};

  for (const [siteKey, choice] of Object.entries(choices)) {
    const source = getGatherSource(siteKey);
    if (choice !== null && source !== null) {
      known[source.key] = choice;
    }
  }

  return known;
}
