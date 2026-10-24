import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { MODE_LABELS, type ModeId, ModeIdSchema, type OrielBridge } from "../shared/shell";
import { useSidebarRail } from "./rail";

const MODE_KEY = "oriel.mode";

/** The mode Oriel showed last, or View on a first start. */
function storedMode(): ModeId {
  const stored = ModeIdSchema.safeParse(window.localStorage.getItem(MODE_KEY));

  return stored.success ? stored.data : "view";
}

interface Shell {
  bridge: OrielBridge;
  /** The mode showing. */
  mode: ModeId;
  /** Every mode opened since the window loaded; each stays mounted, hidden, once opened. */
  opened: ReadonlySet<ModeId>;
  go: (mode: ModeId) => void;
  /** Whether the owner (⌘\) or a narrow window has the sidebar as the rail of icons. */
  rail: boolean;
  toggleRail: () => void;
  /** macOS draws the window buttons over the sidebar's top strip. */
  insetTitleBar: boolean;
}

const ShellContext = createContext<Shell | null>(null);

/**
 * Owns which mode shows. A mode mounts the first time it opens, so its processes start only when
 * the owner first goes there, and stays mounted when the owner leaves.
 */
export function ShellProvider({ bridge, children }: { bridge: OrielBridge; children: ReactNode }) {
  const [mode, setMode] = useState<ModeId>(storedMode);
  const [opened, setOpened] = useState<ReadonlySet<ModeId>>(() => new Set([mode]));
  const { rail, toggle: toggleRail } = useSidebarRail();

  const go = useCallback((next: ModeId) => {
    setMode(next);
    setOpened((current) => (current.has(next) ? current : new Set(current).add(next)));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(MODE_KEY, mode);
    bridge.setMode(mode);
    // The mode names the window in Mission Control, the Window menu and ⌘`.
    document.title = `${MODE_LABELS[mode]} – Oriel`;
  }, [bridge, mode]);

  useEffect(
    () =>
      bridge.onCommand((command) => {
        switch (command.type) {
          case "mode":
            go(command.mode);
            break;
          case "toggle-sidebar":
            toggleRail();
            break;
          default: {
            const _exhaustive: never = command;

            return _exhaustive;
          }
        }
      }),
    [bridge, go, toggleRail],
  );

  const value = useMemo(
    () => ({
      bridge,
      mode,
      opened,
      go,
      rail,
      toggleRail,
      insetTitleBar: bridge.platform === "darwin",
    }),
    [bridge, mode, opened, go, rail, toggleRail],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): Shell {
  const shell = useContext(ShellContext);

  if (!shell) {
    throw new Error("useShell needs a ShellProvider.");
  }

  return shell;
}

const ModeActiveContext = createContext(true);

/** Provides {@link useModeActive} to one mode's tree. */
export const ModeActiveProvider = ModeActiveContext.Provider;

/**
 * Whether this mode is the one on screen. Hidden modes stay mounted, so a listener a mode puts on
 * the whole window (keys, drops) attaches only while this is true.
 */
export function useModeActive(): boolean {
  return useContext(ModeActiveContext);
}
