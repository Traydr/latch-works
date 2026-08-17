import { GallerySortModeSchema } from "@latch-works/media-domain";
import { z } from "zod";

export const ThemeModeSchema = z.enum(["dark", "light", "system"]);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

/**
 * App settings as persisted under `pane-view.settings`. Every field falls
 * back to its default independently, so a stale or hand-edited blob keeps
 * whatever still fits and repairs the rest.
 */
export const AppSettingsSchema = z.object({
  autoplayVideos: z.boolean().catch(false),
  loopNavigation: z.boolean().catch(true),
  loopVideos: z.boolean().catch(false),
  rememberViewerPosition: z.boolean().catch(true),
  showImages: z.boolean().catch(true),
  showVideos: z.boolean().catch(true),
  theme: ThemeModeSchema.catch("system"),
  thumbnailSize: z.number().positive().catch(220),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export type AppSettingsPatch = Partial<AppSettings>;

/**
 * Per-root gallery flags, stored under `pane-view.root-preferences` and
 * written by the browse-state storage adapter after each change. Nothing reads
 * them back yet: a follow-up plan brings Frame View's "exclude this folder from
 * recursive browsing" to Pane View, and per-root storage is where that
 * exclusion list belongs. Do not delete.
 */
export const RootGalleryPreferencesSchema = z.object({
  comicMode: z.boolean(),
  recursive: z.boolean(),
  sortMode: GallerySortModeSchema,
});
export type RootGalleryPreferences = z.infer<typeof RootGalleryPreferencesSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = AppSettingsSchema.parse({});
