import { useState } from "react";
import { GALLERY_HOTKEYS } from "./hotkeys";
import { type AppSettings, type AppSettingsPatch, ThemeModeSchema } from "./types";

interface SettingsDrawerProps {
  onClose: () => void;
  onUpdate: (patch: AppSettingsPatch) => void;
  onUpdateRecursiveDefault: (recursive: boolean) => void;
  open: boolean;
  recursiveDefault: boolean;
  settings: AppSettings;
}

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

export function SettingsDrawer({
  onClose,
  onUpdate,
  onUpdateRecursiveDefault,
  open,
  recursiveDefault,
  settings,
}: SettingsDrawerProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!open) {
    return null;
  }

  // Built on click, so the browser globals are only touched in an event handler.
  const copyDiagnostics = async () => {
    const diagnostics = {
      generatedAt: new Date().toISOString(),
      location: window.location.href,
      settings,
      userAgent: navigator.userAgent,
    };
    await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0"
        aria-label="Close settings"
        onClick={onClose}
      />
      <aside className="relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-balance text-lg font-semibold">Settings</h2>
            <p className="text-pretty text-xs text-muted-foreground">
              Usability, viewer, and diagnostics
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        <div className="space-y-6 overflow-auto px-5 py-4">
          <section className="space-y-3">
            <h3 className="text-balance text-sm font-semibold">Usability</h3>
            <ToggleRow
              checked={recursiveDefault}
              label="Default recursive browsing"
              onChange={onUpdateRecursiveDefault}
            />
            <label className="flex flex-col gap-1 text-sm">
              <span>Theme</span>
              <select
                className="rounded-lg border border-border bg-background px-3 py-2"
                value={settings.theme}
                onChange={(event) => onUpdate({ theme: ThemeModeSchema.parse(event.target.value) })}
              >
                {THEME_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Thumbnail size ({settings.thumbnailSize}px)</span>
              <input
                type="range"
                min={160}
                max={480}
                step={20}
                value={settings.thumbnailSize}
                onChange={(event) => onUpdate({ thumbnailSize: Number(event.target.value) })}
              />
            </label>
            <ToggleRow
              checked={settings.showImages}
              label="Show images"
              onChange={(checked) => onUpdate({ showImages: checked })}
            />
            <ToggleRow
              checked={settings.showVideos}
              label="Show videos"
              onChange={(checked) => onUpdate({ showVideos: checked })}
            />
          </section>

          <section className="space-y-3">
            <h3 className="text-balance text-sm font-semibold">Viewer</h3>
            <ToggleRow
              checked={settings.rememberViewerPosition}
              label="Remember PDF page and video position"
              onChange={(checked) => onUpdate({ rememberViewerPosition: checked })}
            />
            <ToggleRow
              checked={settings.autoplayVideos}
              label="Autoplay videos"
              onChange={(checked) => onUpdate({ autoplayVideos: checked })}
            />
            <ToggleRow
              checked={settings.loopVideos}
              label="Loop videos"
              onChange={(checked) => onUpdate({ loopVideos: checked })}
            />
            <ToggleRow
              checked={settings.loopNavigation}
              label="Loop viewer navigation"
              onChange={(checked) => onUpdate({ loopNavigation: checked })}
            />
          </section>

          <section className="space-y-3">
            <h3 className="text-balance text-sm font-semibold">Keyboard shortcuts</h3>
            <ul className="space-y-2">
              {GALLERY_HOTKEYS.map((entry) => (
                <li key={entry.action} className="flex justify-between gap-3 text-sm">
                  <span>{entry.action}</span>
                  <span className="font-mono text-xs text-muted-foreground">{entry.keys}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3">
            <h3 className="text-balance text-sm font-semibold">Diagnostics</h3>
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-2 text-sm"
              onClick={() => void copyDiagnostics()}
            >
              Copy diagnostics JSON
            </button>
            <button
              type="button"
              className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive"
              onClick={() => setConfirmOpen(true)}
            >
              Clear local preferences
            </button>
            {confirmOpen ? (
              <div className="rounded-lg border border-border p-3 text-sm">
                <p className="mb-3 text-pretty">
                  Clear all Pane View local preferences on this device?
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-border px-3 py-1.5"
                    onClick={() => setConfirmOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-destructive px-3 py-1.5 text-destructive-foreground"
                    onClick={() => {
                      window.localStorage.removeItem("pane-view.state");
                      window.localStorage.removeItem("pane-view.settings");
                      window.localStorage.removeItem("pane-view.root-preferences");
                      setConfirmOpen(false);
                      window.location.reload();
                    }}
                  >
                    Confirm clear
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

function ToggleRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <input
        checked={checked}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
