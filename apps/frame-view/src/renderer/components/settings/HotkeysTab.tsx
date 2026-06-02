import type { JSX } from 'react';

import { formatHotkeys, HOTKEYS } from '../../utils/hotkeys';
import { SettingsSection } from './SettingsSection';

const HOTKEY_GROUPS: { title: string; entries: { action: string; keys: string }[] }[] = [
  {
    title: 'App',
    entries: [
      { action: 'Open folder', keys: 'Ctrl/Cmd+O' },
      { action: 'Refresh folder', keys: 'F5 (Win/Linux) or Cmd/Ctrl+R (macOS)' },
      { action: 'Open preferences', keys: 'Ctrl/Cmd+,' },
    ],
  },
  {
    title: 'Gallery',
    entries: [
      { action: 'Previous/next item', keys: 'Left/Right or A/D' },
      { action: 'Row jump', keys: 'Up/Down or W/S' },
      { action: 'Open selected item', keys: formatHotkeys(HOTKEYS.galleryActivate) },
      {
        action: 'Parent/prev/next folder',
        keys: `${formatHotkeys(HOTKEYS.openParentFolder)} / ${formatHotkeys(
          HOTKEYS.previousFolder,
        )} / ${formatHotkeys(HOTKEYS.nextFolder)}`,
      },
      { action: 'Open selected folder', keys: formatHotkeys(HOTKEYS.openSelectedFolder) },
      { action: 'Close sort menu', keys: 'Escape (when sort menu is open)' },
    ],
  },
  {
    title: 'Viewer',
    entries: [
      { action: 'Close viewer', keys: formatHotkeys(HOTKEYS.close) },
      { action: 'Previous page/item', keys: formatHotkeys(HOTKEYS.viewerPrevious) },
      { action: 'Next page/item', keys: formatHotkeys(HOTKEYS.viewerNext) },
      { action: 'Play/pause video', keys: formatHotkeys(HOTKEYS.videoPlayPause) },
      {
        action: 'Seek video -/+ 5s',
        keys: `${formatHotkeys(HOTKEYS.videoSeekBackward)} / ${formatHotkeys(
          HOTKEYS.videoSeekForward,
        )}`,
      },
      { action: 'Hold 2x speed', keys: `Hold ${formatHotkeys(HOTKEYS.videoTemporarySpeed)}` },
    ],
  },
];

export function HotkeysTab(): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-zinc-500 dark:text-zinc-400">
        Keyboard-first navigation is built into the gallery and viewer. Use this as the quick
        reference.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {HOTKEY_GROUPS.map((group) => (
          <SettingsSection key={group.title} className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {group.title}
            </p>
            <div className="space-y-1.5 text-xs text-zinc-600 dark:text-zinc-300">
              {group.entries.map((entry) => (
                <div
                  key={entry.action}
                  className="space-y-1 rounded-lg border border-zinc-200/70 bg-white/50 px-2 py-1.5 dark:border-zinc-700/70 dark:bg-zinc-900/40"
                >
                  <p>{entry.action}</p>
                  <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                    {entry.keys}
                  </p>
                </div>
              ))}
            </div>
          </SettingsSection>
        ))}
      </div>
    </div>
  );
}
