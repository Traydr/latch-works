import { createContext, type ReactNode, useContext } from "react";
import type { GalleryBrowseState } from "@/features/gallery/useGalleryBrowseState";
import type { AppSettings, AppSettingsPatch } from "@/features/settings/types";

/**
 * What GalleryLayout owns and GalleryPage consumes: the one browse-state
 * instance, the one app-settings instance, and the settings drawer's open
 * flag (the sidebar's settings button lives in the layout; the drawer renders
 * in the page).
 */
export interface GalleryLayoutValue {
  browse: GalleryBrowseState;
  setSettingsOpen: (open: boolean) => void;
  settings: AppSettings;
  settingsOpen: boolean;
  updateSettings: (patch: AppSettingsPatch) => void;
}

const GalleryLayoutContext = createContext<GalleryLayoutValue | null>(null);

export function GalleryLayoutProvider({
  children,
  value,
}: Readonly<{ children: ReactNode; value: GalleryLayoutValue }>) {
  return <GalleryLayoutContext.Provider value={value}>{children}</GalleryLayoutContext.Provider>;
}

export function useGalleryLayout(): GalleryLayoutValue {
  const value = useContext(GalleryLayoutContext);
  if (!value) {
    throw new Error("useGalleryLayout must be used within GalleryLayoutProvider");
  }
  return value;
}
