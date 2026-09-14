import { type JSX, useEffect, useState } from 'react';

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
  const [thumbnailSizeDraft, setThumbnailSizeDraft] = useState(settings.thumbnailSize);

  useEffect(() => {
    setThumbnailSizeDraft(settings.thumbnailSize);
  }, [settings.thumbnailSize]);

  return (
    <div className="space-y-4">
      <SettingsSection className="space-y-1.5">
        <span className="text-zinc-500 dark:text-zinc-400">Theme</span>
        <fieldset className="m-0 inline-flex gap-1 rounded-2xl border-0 bg-zinc-100/80 p-1 dark:bg-zinc-900/60">
          <legend className="sr-only">Theme</legend>
          {THEME_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="cursor-pointer rounded-xl px-3 py-1.5 text-sm text-zinc-600 transition hover:bg-white/60 has-checked:bg-white has-checked:text-violet-700 has-checked:shadow-sm dark:text-zinc-300 dark:hover:bg-zinc-800/60 dark:has-checked:bg-zinc-800 dark:has-checked:text-violet-300"
            >
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={option.value === settings.theme}
                className="sr-only"
                onChange={() => onUpdate({ theme: option.value })}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
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
