export type ThemeMode = "dark" | "light" | "system";

export interface AppSettings {
  autoplayVideos: boolean;
  loopNavigation: boolean;
  loopVideos: boolean;
  showImages: boolean;
  showVideos: boolean;
  theme: ThemeMode;
  thumbnailSize: number;
}

export type AppSettingsPatch = Partial<AppSettings>;

export interface RootGalleryPreferences {
  comicMode: boolean;
  recursive: boolean;
  sortMode: import("@latch-works/media-domain").GallerySortMode;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoplayVideos: false,
  loopNavigation: true,
  loopVideos: false,
  showImages: true,
  showVideos: true,
  theme: "system",
  thumbnailSize: 220,
};
