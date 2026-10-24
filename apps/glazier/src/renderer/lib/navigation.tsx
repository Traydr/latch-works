import type {
  AudioState,
  FileFlag,
  FileFormat,
  FileKind,
} from "@latch-works/glazier-core/contract";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

const VIEWS = [
  "overview",
  "library",
  "duplicates",
  "optimize",
  "sound",
  "holding",
  "journal",
  "settings",
] as const;

export type View = (typeof VIEWS)[number];

/** A starting filter for the Library, set when another view links to a set of files. */
export interface LibraryPreset {
  kinds: FileKind[];
  formats: FileFormat[];
  audioStates: AudioState[];
  flags: FileFlag[];
  search: string;
}

export const EMPTY_PRESET: LibraryPreset = {
  kinds: [],
  formats: [],
  audioStates: [],
  flags: [],
  search: "",
};

interface Navigation {
  view: View;
  preset: LibraryPreset;
  go: (view: View) => void;
  openLibrary: (preset: Partial<LibraryPreset>) => void;
}

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>("overview");
  const [preset, setPreset] = useState<LibraryPreset>(EMPTY_PRESET);

  const value = useMemo<Navigation>(
    () => ({
      view,
      preset,
      go: setView,
      openLibrary: (next) => {
        // A new object every time, so the Library re-applies even an identical preset.
        setPreset({ ...EMPTY_PRESET, ...next });
        setView("library");
      },
    }),
    [view, preset],
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);

  if (!navigation) {
    throw new Error("useNavigation needs a NavigationProvider.");
  }

  return navigation;
}
