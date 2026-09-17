import { type JSX, useEffect, useEffectEvent, useRef, useState } from 'react';

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
import { SettingsTabNav } from './settings/SettingsTabNav';
import { SETTINGS_TABS, type SettingsTab } from './settings/settingsTabs';
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

/**
 * Preferences is anchored to the top of the window at a fixed height, so
 * switching tabs never resizes or moves it: short tabs leave room below, tall
 * tabs scroll inside the body.
 */
export function SettingsDrawer({
  currentFolderSummary,
  diagnosticsSnapshot,
  mediaIndexStats,
  mediaToolsStatus,
  onClearMediaIndex,
  onClearThumbnailCache,
  onClose,
  onCopyDiagnostics,
  onRefreshDiagnostics,
  onUpdate,
  settings,
}: SettingsDrawerProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>(SETTINGS_TABS[0]);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeEvent = useEffectEvent(onClose);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeEvent();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/35 pt-[7vh] backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0"
        onClick={onClose}
        aria-label="Close settings"
      />

      <aside
        aria-label="Preferences"
        className="prism-surface z-10 mx-6 flex h-[min(78vh,760px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-inherit px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold text-balance text-zinc-900 dark:text-zinc-100">
              Preferences
            </h2>
            <p className="text-xs text-pretty text-zinc-500 dark:text-zinc-400">
              Organize usability, storage, shortcuts, and diagnostics in one place.
            </p>
          </div>
          <button ref={closeButtonRef} type="button" className="prism-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="border-b border-inherit px-4 py-3">
          <SettingsTabNav activeTab={activeTab} onSelectTab={setActiveTab} />
        </div>

        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto p-4 text-sm text-zinc-700 dark:text-zinc-200"
        >
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
