import type {
  AudioState,
  FileFlag,
  FileFormat,
  FileKind,
} from "@latch-works/glazier-core/contract";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

/**
 * Overview is home. Duplicates, Convert and Clean up are the work, in the order it is best done;
 * Library and History are the archive; Holding and Settings sit at the foot of the sidebar.
 */
const VIEWS = [
  "overview",
  "duplicates",
  "convert",
  "cleanup",
  "library",
  "history",
  "holding",
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
  dir: string | null;
}

export const EMPTY_PRESET: LibraryPreset = {
  kinds: [],
  formats: [],
  audioStates: [],
  flags: [],
  search: "",
  dir: null,
};

/** Which tab Duplicates opens on: similar versions, or identical copies. */
type DuplicatesTab = "similar" | "exact";

interface Navigation {
  view: View;
  preset: LibraryPreset;
  go: (view: View) => void;
  openLibrary: (preset: Partial<LibraryPreset>) => void;
  /** The tab Duplicates was last asked to open on; it reads this when it mounts. */
  duplicatesTab: { tab: DuplicatesTab; at: number } | null;
  openDuplicates: (tab: DuplicatesTab) => void;
  /** Set by ⌘F from another view; the Library focuses its search and clears it. */
  searchRequested: boolean;
  requestSearch: () => void;
  clearSearchRequest: () => void;
}

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>("overview");
  const [preset, setPreset] = useState<LibraryPreset>(EMPTY_PRESET);
  const [searchRequested, setSearchRequested] = useState(false);
  const [duplicatesTab, setDuplicatesTab] = useState<Navigation["duplicatesTab"]>(null);

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
      duplicatesTab,
      openDuplicates: (tab) => {
        setDuplicatesTab({ tab, at: Date.now() });
        setView("duplicates");
      },
      searchRequested,
      requestSearch: () => {
        setSearchRequested(true);
        setView("library");
      },
      clearSearchRequest: () => setSearchRequested(false),
    }),
    [view, preset, duplicatesTab, searchRequested],
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
