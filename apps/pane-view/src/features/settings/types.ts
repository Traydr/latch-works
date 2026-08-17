export type ThemeMode = "dark" | "light" | "system";

export interface AppSettings {
  autoplayVideos: boolean;
  loopNavigation: boolean;
  loopVideos: boolean;
  rememberViewerPosition: boolean;
  showImages: boolean;
  showVideos: boolean;
  theme: ThemeMode;
  thumbnailSize: number;
}

export type AppSettingsPatch = Partial<AppSettings>;

/**
 * Per-root gallery flags, stored under `pane-view.root-preferences` and
 * written by the browse-state storage adapter after each change. Nothing reads
 * them back yet: a follow-up plan brings Frame View's "exclude this folder from
 * recursive browsing" to Pane View, and per-root storage is where that
 * exclusion list belongs. Do not delete.
 */
export interface RootGalleryPreferences {
  comicMode: boolean;
  recursive: boolean;
  sortMode: import("@latch-works/media-domain").GallerySortMode;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoplayVideos: false,
  loopNavigation: true,
  loopVideos: false,
  rememberViewerPosition: true,
  showImages: true,
  showVideos: true,
  theme: "system",
  thumbnailSize: 220,
};
