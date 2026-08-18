import { type JSX, useEffect, useRef, useState } from 'react';

import type { AppSettings, AppSettingsPatch, ThemeMode } from '../../../shared/types';
import { SettingsSection } from './SettingsSection';
import { SettingsToggleRow } from './SettingsToggleRow';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

interface UsabilityTabProps {
  onUpdate: (patch: AppSettingsPatch) => void;
  settings: AppSettings;
}

export function UsabilityTab({ onUpdate, settings }: UsabilityTabProps): JSX.Element {
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [thumbnailSizeDraft, setThumbnailSizeDraft] = useState(settings.thumbnailSize);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);

  const activeThemeLabel =
    THEME_OPTIONS.find((option) => option.value === settings.theme)?.label ?? 'System';

  useEffect(() => {
    if (!themeMenuOpen) {
      return undefined;
    }

    const onMouseDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && themeMenuRef.current?.contains(event.target)) {
        return;
      }

      setThemeMenuOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setThemeMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [themeMenuOpen]);

  useEffect(() => {
    setThumbnailSizeDraft(settings.thumbnailSize);
  }, [settings.thumbnailSize]);

  return (
    <div className="space-y-4">
      <SettingsSection className="space-y-1.5">
        <span className="text-zinc-500 dark:text-zinc-400">Theme</span>
        <div ref={themeMenuRef} className="relative">
          <button
            type="button"
            className={`prism-btn flex w-full items-center justify-between gap-2 ${
              themeMenuOpen ? 'bg-zinc-200 dark:bg-zinc-700' : ''
            }`}
            onClick={() => setThemeMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={themeMenuOpen}
          >
            <span>{activeThemeLabel}</span>
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-3 w-3 transition-transform ${themeMenuOpen ? 'rotate-180' : ''}`}
            >
              <path d="M5.5 7.5 10 12l4.5-4.5" />
            </svg>
          </button>

          {themeMenuOpen ? (
            <div
              className="prism-surface absolute left-0 top-[calc(100%+0.5rem)] z-20 w-full p-1"
              role="menu"
            >
              {THEME_OPTIONS.map((option) => {
                const selected = option.value === settings.theme;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                      selected
                        ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
                        : 'text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-700'
                    }`}
                    onClick={() => {
                      onUpdate({ theme: option.value });
                      setThemeMenuOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {selected ? <span>•</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <div className="grid gap-4 md:grid-cols-2">
        <SettingsSection className="space-y-2">
          <SettingsToggleRow
            checked={settings.rememberLastFolder}
            label="Remember last folder"
            onChange={(checked) => onUpdate({ rememberLastFolder: checked })}
          />
          <SettingsToggleRow
            checked={settings.recursiveDefault}
            label="Enable recursive mode by default"
            onChange={(checked) => onUpdate({ recursiveDefault: checked })}
          />
          <SettingsToggleRow
            checked={settings.autoplayOnHover}
            label="Autoplay video on hover"
            onChange={(checked) => onUpdate({ autoplayOnHover: checked })}
          />
          <SettingsToggleRow
            checked={settings.autoplayVideos}
            label="Autoplay videos in viewer"
            onChange={(checked) => onUpdate({ autoplayVideos: checked })}
          />
          <SettingsToggleRow
            checked={settings.loopViewerNavigation}
            label="Loop viewer navigation"
            onChange={(checked) => onUpdate({ loopViewerNavigation: checked })}
          />
          <SettingsToggleRow
            checked={settings.previewAudioEnabled}
            label="Enable audio in video preview"
            onChange={(checked) => onUpdate({ previewAudioEnabled: checked })}
          />
          <SettingsToggleRow
            checked={settings.loopVideos}
            label="Loop videos"
            onChange={(checked) => onUpdate({ loopVideos: checked })}
          />
        </SettingsSection>

        <div className="space-y-4">
          <label className="prism-section block space-y-1.5">
            <span className="text-zinc-500 tabular-nums dark:text-zinc-400">
              Thumbnail size: {thumbnailSizeDraft}px
            </span>
            <input
              type="range"
              min={140}
              max={340}
              step={10}
              value={thumbnailSizeDraft}
              className="w-full accent-violet-500"
              onChange={(event) => setThumbnailSizeDraft(Number(event.target.value))}
              onPointerUp={() => {
                if (thumbnailSizeDraft !== settings.thumbnailSize) {
                  onUpdate({ thumbnailSize: thumbnailSizeDraft });
                }
              }}
              onKeyUp={() => {
                if (thumbnailSizeDraft !== settings.thumbnailSize) {
                  onUpdate({ thumbnailSize: thumbnailSizeDraft });
                }
              }}
              onBlur={() => {
                if (thumbnailSizeDraft !== settings.thumbnailSize) {
                  onUpdate({ thumbnailSize: thumbnailSizeDraft });
                }
              }}
            />
          </label>

          <SettingsSection className="space-y-2">
            <p className="text-zinc-500 dark:text-zinc-400">Visible media types</p>
            <SettingsToggleRow
              checked={settings.filters.showImages}
              label="Show images"
              onChange={(checked) =>
                onUpdate({
                  filters: {
                    ...settings.filters,
                    showImages: checked,
                  },
                })
              }
            />
            <SettingsToggleRow
              checked={settings.filters.showVideos}
              label="Show videos"
              onChange={(checked) =>
                onUpdate({
                  filters: {
                    ...settings.filters,
                    showVideos: checked,
                  },
                })
              }
            />
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
