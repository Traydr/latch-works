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

/** A section of Settings: the app's own, or one mode's. */
export type SettingsSection = "general" | ModeId;

/** Work a mode is doing, for its switcher button while another mode shows. */
export type ModeActivity = { kind: "working" } | { kind: "progress"; ratio: number };

interface Shell {
  bridge: OrielBridge;
  /** The mode showing. */
  mode: ModeId;
  /** Every mode opened since the window loaded; each stays mounted, hidden, once opened. */
  opened: ReadonlySet<ModeId>;
  /** Shows a mode, closing Settings. */
  go: (mode: ModeId) => void;
  /** Whether the owner (⌘\) or a narrow window has the sidebar as the rail of icons. */
  rail: boolean;
  toggleRail: () => void;
  /** macOS draws the window buttons over the sidebar's top strip. */
  insetTitleBar: boolean;
  /** The Settings section showing, or null while Settings is closed. */
  settings: SettingsSection | null;
  /** Opens Settings at `section`; a mode's section shows that mode, which draws it. */
  openSettings: (section: SettingsSection) => void;
  closeSettings: () => void;
  /** Each mode's running work, as it last reported. */
  activity: Partial<Record<ModeId, ModeActivity>>;
  reportActivity: (mode: ModeId, activity: ModeActivity | null) => void;
}

const ShellContext = createContext<Shell | null>(null);

/**
 * Owns which mode shows, and Settings. A mode mounts the first time it opens, so its processes
 * start only when the owner first goes there, and stays mounted when the owner leaves.
 */
export function ShellProvider({ bridge, children }: { bridge: OrielBridge; children: ReactNode }) {
  const [mode, setMode] = useState<ModeId>(storedMode);
  const [opened, setOpened] = useState<ReadonlySet<ModeId>>(() => new Set([mode]));
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [activity, setActivity] = useState<Partial<Record<ModeId, ModeActivity>>>({});
  const { rail, toggle: toggleRail } = useSidebarRail();

  const show = useCallback((next: ModeId) => {
    setMode(next);
    setOpened((current) => (current.has(next) ? current : new Set(current).add(next)));
  }, []);

  const go = useCallback(
    (next: ModeId) => {
      setSettings(null);
      show(next);
    },
    [show],
  );

  const openSettings = useCallback(
    (section: SettingsSection) => {
      setSettings(section);

      if (section !== "general") {
        show(section);
      }
    },
    [show],
  );

  const closeSettings = useCallback(() => setSettings(null), []);

  const reportActivity = useCallback((of: ModeId, next: ModeActivity | null) => {
    setActivity((current) => {
      const copy = { ...current };

      if (next === null) {
        delete copy[of];
      } else {
        copy[of] = next;
      }

      return copy;
    });
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
          case "settings":
            openSettings(mode);
            break;
          default: {
            const _exhaustive: never = command;

            return _exhaustive;
          }
        }
      }),
    [bridge, go, mode, openSettings, toggleRail],
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
      settings,
      openSettings,
      closeSettings,
      activity,
      reportActivity,
    }),
    [
      bridge,
      mode,
      opened,
      go,
      rail,
      toggleRail,
      settings,
      openSettings,
      closeSettings,
      activity,
      reportActivity,
    ],
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

const ModeContext = createContext<{ id: ModeId; active: boolean } | null>(null);

/** Provides {@link useModeActive} and {@link useReportActivity} to one mode's tree. */
export const ModeProvider = ModeContext.Provider;

function useMode(): { id: ModeId; active: boolean } {
  const mode = useContext(ModeContext);

  if (!mode) {
    throw new Error("A mode's components need a ModeProvider.");
  }

  return mode;
}

/**
 * Whether this mode is the one on screen. Hidden modes stay mounted, so a listener a mode puts on
 * the whole window (keys, drops) attaches only while this is true.
 */
export function useModeActive(): boolean {
  return useMode().active;
}

/** The progress ring's step, so a run's events re-render the switcher at most a hundred times. */
function activityKey(activity: ModeActivity | null): string {
  if (activity === null) {
    return "idle";
  }

  return activity.kind === "progress" ? `progress:${Math.round(activity.ratio * 100)}` : "working";
}

/** Reports this mode's running work to the switcher, which shows it while another mode is on. */
export function useReportActivity(activity: ModeActivity | null): void {
  const { id } = useMode();
  const { reportActivity } = useShell();
  const key = activityKey(activity);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `activity`, which is a new object on every render.
  useEffect(() => {
    reportActivity(id, activity);

    return () => reportActivity(id, null);
  }, [id, key, reportActivity]);
}
