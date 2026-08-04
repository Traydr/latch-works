import type { JSX } from 'react';

import { SETTINGS_TABS, type SettingsTab } from './settingsTabs';

interface SettingsTabNavProps {
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
}

export function SettingsTabNav({ activeTab, onSelectTab }: SettingsTabNavProps): JSX.Element {
  return (
    <div className="inline-flex flex-wrap gap-2 rounded-2xl bg-zinc-100/80 p-1 dark:bg-zinc-900/60">
      {SETTINGS_TABS.map((tab) => {
        const selected = tab === activeTab;
        return (
          <button
            key={tab}
            type="button"
            className={`rounded-xl px-3 py-1.5 text-sm transition ${
              selected
                ? 'bg-white text-violet-700 shadow-sm dark:bg-zinc-800 dark:text-violet-300'
                : 'text-zinc-600 hover:bg-white/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
            }`}
            onClick={() => onSelectTab(tab)}
          >
            {tab}
          </button>
        );
      })}
    </div>
  );
}
