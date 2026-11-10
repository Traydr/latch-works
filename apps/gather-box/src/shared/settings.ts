import * as z from "zod/mini";
import { DOWNLOAD_CONCURRENCY, readPageShortcutsEnabled, SETTINGS_KEY } from "./constants";
import { getGatherSource, type SiteKey } from "./source-catalog";

export const CredentialsModeSchema = z.enum(["auto", "always", "never", "perSite"]);

type CredentialsMode = z.infer<typeof CredentialsModeSchema>;

export const CredentialsChoiceSchema = z.enum(["include", "omit"]);

export type CredentialsChoice = z.infer<typeof CredentialsChoiceSchema>;

export interface GatherBoxSettings {
  downloadConcurrency: number;
  mediaCompatibilityMode: boolean;
  useGlobalFolder: boolean;
  xPostFolders: boolean;
  verboseLogging: boolean;
  pageShortcutsEnabled: boolean;
  credentialsMode: CredentialsMode;
  credentialsPerSite: Partial<Record<SiteKey, CredentialsChoice>>;
}

export const DEFAULT_SETTINGS: GatherBoxSettings = {
  downloadConcurrency: DOWNLOAD_CONCURRENCY.default,
  mediaCompatibilityMode: false,
  useGlobalFolder: false,
  xPostFolders: false,
  verboseLogging: false,
  pageShortcutsEnabled: true,
  credentialsMode: "auto",
  credentialsPerSite: {},
};

/**
 * Settings survive extension upgrades, so no field can reject the record: each one falls back to
 * its default. `shortcutsEnabled` is the pre-rename name of `pageShortcutsEnabled`.
 */
export const GatherBoxSettingsSchema = z.catch(
  z.pipe(
    z.object({
      downloadConcurrency: z.pipe(
        z.catch(z.coerce.number(), DEFAULT_SETTINGS.downloadConcurrency),
        z.transform((value) =>
          Math.min(DOWNLOAD_CONCURRENCY.max, Math.max(DOWNLOAD_CONCURRENCY.min, Math.round(value))),
        ),
      ),
      mediaCompatibilityMode: z.catch(z.coerce.boolean(), false),
      useGlobalFolder: z.catch(z.coerce.boolean(), false),
      xPostFolders: z.catch(z.coerce.boolean(), false),
      verboseLogging: z.catch(z.coerce.boolean(), false),
      pageShortcutsEnabled: z.optional(z.coerce.boolean()),
      shortcutsEnabled: z.optional(z.coerce.boolean()),
      credentialsMode: z.catch(CredentialsModeSchema, DEFAULT_SETTINGS.credentialsMode),
      credentialsPerSite: z.catch(
        z.record(z.string(), z.catch(z.nullable(CredentialsChoiceSchema), null)),
        {},
      ),
    }),
    z.transform(
      (stored): GatherBoxSettings => ({
        downloadConcurrency: stored.downloadConcurrency,
        mediaCompatibilityMode: stored.mediaCompatibilityMode,
        useGlobalFolder: stored.useGlobalFolder,
        xPostFolders: stored.xPostFolders,
        verboseLogging: stored.verboseLogging,
        pageShortcutsEnabled: readPageShortcutsEnabled(stored),
        credentialsMode: stored.credentialsMode,
        credentialsPerSite: keepKnownSources(stored.credentialsPerSite),
      }),
    ),
  ),
  () => ({ ...DEFAULT_SETTINGS, credentialsPerSite: {} }),
);

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
