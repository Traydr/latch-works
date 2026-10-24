import {
  ArrowLeft,
  FolderOpen,
  Images,
  type LucideIcon,
  RefreshCw,
  SlidersHorizontal,
  WandSparkles,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { type About, MODE_LABELS } from "../shared/shell";
import { Segmented } from "../ui/ui";
import { type SettingsSection, useModeActive, useModeId, useShell } from "./shell";
import { type ThemeChoice, useTheme } from "./theme";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "view", label: "View", icon: Images },
  { id: "tidy", label: "Tidy", icon: WandSparkles },
  { id: "sync", label: "Sync", icon: RefreshCw },
] as const satisfies ReadonlyArray<{ id: SettingsSection; label: string; icon: LucideIcon }>;

/** A titled group of rows in a card, as System Settings groups them. */
export function SettingsGroup({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="lw-heading mb-2 px-1">{title}</h2>
      <div className="lw-card overflow-hidden">{children}</div>
    </section>
  );
}

/** A settings row: the label and its one-line description on the left, the control right. */
export function SettingsRow({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[52px] items-center gap-4 border-t lw-divider px-4 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {description ? <p className="lw-caption mt-0.5">{description}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies ReadonlyArray<{ value: ThemeChoice; label: string }>;

/** Oriel's own settings: the one theme every mode follows, its data, and its version. */
function GeneralSettings() {
  const { bridge } = useShell();
  const { choice, choose } = useTheme();
  const [about, setAbout] = useState<About | null>(null);

  useEffect(() => {
    void bridge.about().then(setAbout);
  }, [bridge]);

  return (
    <>
      <SettingsGroup title="Appearance">
        <SettingsRow label="Theme" description="View, Tidy and Sync all follow it.">
          <Segmented label="Theme" options={THEMES} value={choice} onChange={choose} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Data">
        <SettingsRow
          label="Data folder"
          description={
            about ? about.dataFolder : "Where every mode keeps its catalogs and settings."
          }
        >
          <button
            type="button"
            className="lw-btn lw-btn-secondary"
            onClick={() => bridge.revealDataFolder()}
          >
            <FolderOpen />
            {bridge.platform === "darwin" ? "Show in Finder" : "Show in Explorer"}
          </button>
        </SettingsRow>
        <SettingsRow
          label="Frame View, Glazier and Lockstep"
          description="Bring their preferences and saved sync tokens in again, and remove them if they are still installed."
        >
          <button
            type="button"
            className="lw-btn lw-btn-secondary"
            onClick={() => bridge.importOldApps()}
          >
            Import…
          </button>
        </SettingsRow>
      </SettingsGroup>

      {about ? <p className="lw-caption mt-6 px-1">Oriel {about.version}</p> : null}
    </>
  );
}

/**
 * Settings, over the whole window: the sections on the left (Oriel's own, then one per mode) and
 * the one showing on the right. The way back sits at the sidebar's bottom left, where Settings
 * was. A mode draws its own section, `section`, inside its own tree; the mode underneath stays
 * mounted, so closing Settings returns to it as it was.
 */
export function SettingsFrame({ section }: { section: ReactNode }) {
  const { settings, openSettings, closeSettings } = useShell();
  const active = useModeActive();
  const mode = useModeId();

  useEffect(() => {
    if (!active) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        closeSettings();
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [active, closeSettings]);

  const current = SECTIONS.find(({ id }) => id === settings) ?? SECTIONS[0];

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <aside className="flex w-60 shrink-0 flex-col border-r lw-divider bg-zinc-50 dark:bg-zinc-900/60">
        <div className="lw-drag h-[52px] w-full shrink-0" />
        <nav aria-label="Settings sections" className="px-2">
          <ul className="space-y-0.5">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  className="lw-sidebar-item"
                  aria-current={id === current.id ? "page" : undefined}
                  data-settings-section={id}
                  onClick={() => openSettings(id)}
                >
                  <Icon />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mt-auto px-2 pb-3">
          <button
            type="button"
            className="lw-sidebar-item"
            title="Esc"
            data-settings-back
            onClick={closeSettings}
          >
            <ArrowLeft />
            <span className="min-w-0 flex-1 truncate">Back to {MODE_LABELS[mode]}</span>
          </button>
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="lw-drag flex h-[52px] shrink-0 items-center gap-4 border-b lw-divider px-5">
          <h1 className="lw-title truncate">{current.label}</h1>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[640px] px-6 pt-6 pb-28">
            {current.id === "general" ? <GeneralSettings /> : section}
          </div>
        </div>
      </div>
    </div>
  );
}
