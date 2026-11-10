import { z } from "zod";

export const ThemeModeSchema = z.enum(["dark", "light", "system"]);

/**
 * App settings as persisted under `pane-view.settings`. Every field falls
 * back to its default independently, so a stale or hand-edited blob keeps
 * whatever still fits and repairs the rest.
 */
export const AppSettingsSchema = z.object({
  autoplayVideos: z.boolean().catch(false),
  loopNavigation: z.boolean().catch(true),
  loopVideos: z.boolean().catch(false),
  rememberViewerPosition: z.boolean().catch(false),
  showImages: z.boolean().catch(true),
  showVideos: z.boolean().catch(true),
  theme: ThemeModeSchema.catch("system"),
  thumbnailSize: z.number().positive().catch(220),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export type AppSettingsPatch = Partial<AppSettings>;

export const DEFAULT_APP_SETTINGS: AppSettings = AppSettingsSchema.parse({});
