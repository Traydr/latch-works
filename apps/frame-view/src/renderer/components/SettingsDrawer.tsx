import { type JSX, useEffect, useState } from 'react';

import type {
  AppSettings,
  AppSettingsPatch,
  DiagnosticsSnapshot,
  MediaIndexStats,
  MediaToolsStatus,
} from '../../shared/types';
import { DebugTab } from './settings/DebugTab';
import { HotkeysTab } from './settings/HotkeysTab';
import { LocalStorageTab } from './settings/LocalStorageTab';
import { SETTINGS_TABS, type SettingsTab, SettingsTabNav } from './settings/SettingsTabNav';
import { UsabilityTab } from './settings/UsabilityTab';

interface CurrentFolderSummary {
  folderName: string | null;
  itemCount: number;
  recursive: boolean;
  scanState: 'idle' | 'loading' | 'done' | 'error';
}

interface SettingsDrawerProps {
  currentFolderSummary: CurrentFolderSummary;
  diagnosticsSnapshot: DiagnosticsSnapshot | null;
  isOpen: boolean;
  mediaIndexStats: MediaIndexStats | null;
  mediaToolsStatus: MediaToolsStatus | null;
  onClearMediaIndex: () => void;
  onClearThumbnailCache: () => void;
  onClose: () => void;
  onCopyDiagnostics: () => Promise<void> | void;
  onRefreshDiagnostics: () => Promise<void> | void;
  onUpdate: (patch: AppSettingsPatch) => void;
  settings: AppSettings;
}

export function SettingsDrawer({
  currentFolderSummary,
  diagnosticsSnapshot,
  isOpen,
  mediaIndexStats,
  mediaToolsStatus,
  onClearMediaIndex,
  onClearThumbnailCache,
  onClose,
  onCopyDiagnostics,
  onRefreshDiagnostics,
  onUpdate,
  settings,
}: SettingsDrawerProps): JSX.Element | null {
  const [activeTab, setActiveTab] = useState<SettingsTab>(SETTINGS_TABS[0]);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setActiveTab(SETTINGS_TABS[0]);
      setCopyStatus(null);
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0"
        onClick={onClose}
        aria-label="Close settings"
      />

      <aside className="prism-surface z-10 mx-6 flex max-h-[78vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between border-b border-inherit px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold text-balance text-zinc-900 dark:text-zinc-100">
              Preferences
            </h2>
            <p className="text-xs text-pretty text-zinc-500 dark:text-zinc-400">
              Organize usability, storage, shortcuts, and diagnostics in one place.
            </p>
          </div>
          <button type="button" className="prism-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="border-b border-inherit px-4 py-3">
          <SettingsTabNav activeTab={activeTab} onSelectTab={setActiveTab} />
        </div>

        <div className="overflow-y-auto p-4 text-sm text-zinc-700 dark:text-zinc-200">
          {activeTab === 'Usability' ? (
            <UsabilityTab settings={settings} onUpdate={onUpdate} />
          ) : null}
          {activeTab === 'Local Storage' ? (
            <LocalStorageTab
              mediaIndexStats={mediaIndexStats}
              mediaToolsStatus={mediaToolsStatus}
              onClearMediaIndex={onClearMediaIndex}
              onClearThumbnailCache={onClearThumbnailCache}
            />
          ) : null}
          {activeTab === 'Hotkeys' ? <HotkeysTab /> : null}
          {activeTab === 'Debug' ? (
            <DebugTab
              copyStatus={copyStatus}
              currentFolderSummary={currentFolderSummary}
              diagnosticsSnapshot={diagnosticsSnapshot}
              mediaIndexStats={mediaIndexStats}
              onCopyDiagnostics={() => {
                void (async () => {
                  try {
                    await onCopyDiagnostics();
                    setCopyStatus('Diagnostics copied to clipboard');
                  } catch {
                    setCopyStatus('Failed to copy diagnostics');
                  }
                })();
              }}
              onRefreshDiagnostics={() => {
                void (async () => {
                  try {
                    await onRefreshDiagnostics();
                    setCopyStatus('Diagnostics refreshed');
                  } catch {
                    setCopyStatus('Failed to refresh diagnostics');
                  }
                })();
              }}
              onUpdate={onUpdate}
              settings={settings}
            />
          ) : null}
        </div>
      </aside>
    </div>
  );
}
