import { Result } from 'better-result';
import { useCallback, useRef, useState } from 'react';

import type { AppSettings, AppSettingsPatch } from '../../shared/types';
import { frameViewClientResult } from '../services/frameViewClient';
import { buildDiagnosticsReport } from '../utils/diagnostics';
import { getFrameViewErrorMessage } from '../utils/frameViewResult';
import { toDisplayName } from '../utils/path';

interface UseSettingsActionsOptions {
  initializeSettings: (settings: AppSettings) => void;
  mediaEntryCount: number;
  recursive: boolean;
  refreshSettingsPanelData: () => Promise<void>;
  rootPath: string | null;
  runScan: (
    folderPath: string,
    options?: {
      excludedRootChildPaths?: string[];
      filters?: AppSettings['filters'];
      recursive?: boolean;
    },
  ) => Promise<boolean>;
  scanState: 'idle' | 'loading' | 'done' | 'error';
}

interface UseSettingsActionsResult {
  cacheStatusMessage: string | null;
  clearMediaIndexAction: () => void;
  clearThumbnailCacheAction: () => void;
  copyDiagnosticsAction: () => void;
  refreshDiagnosticsAction: () => void;
  updateSettings: (patch: AppSettingsPatch) => Promise<void>;
}

export function useSettingsActions({
  initializeSettings,
  mediaEntryCount,
  recursive,
  refreshSettingsPanelData,
  rootPath,
  runScan,
  scanState,
}: UseSettingsActionsOptions): UseSettingsActionsResult {
  const [cacheStatusMessage, setCacheStatusMessage] = useState<string | null>(null);
  const settingsUpdateQueueRef = useRef<Promise<void>>(Promise.resolve());

  const scheduleStatusReset = useCallback((message: string): void => {
    setCacheStatusMessage(message);
    window.setTimeout(() => {
      setCacheStatusMessage(null);
    }, 2200);
  }, []);

  const updateSettings = useCallback(
    async (patch: AppSettingsPatch): Promise<void> => {
      const runUpdate = async (): Promise<void> => {
        const result = await frameViewClientResult.updateSettings(patch);
        if (Result.isError(result)) {
          console.error('[frameView:update-settings]', result.error);
          scheduleStatusReset(`Settings update failed: ${result.error.message}`);
          return;
        }

        const updated = result.value;
        initializeSettings(updated);

        if (rootPath && patch.filters) {
          await runScan(rootPath, {
            filters: updated.filters,
            recursive,
          });
        }
      };

      settingsUpdateQueueRef.current = settingsUpdateQueueRef.current.then(runUpdate, runUpdate);
      await settingsUpdateQueueRef.current;
    },
    [initializeSettings, recursive, rootPath, runScan],
  );

  const copyDiagnosticsAction = useCallback((): void => {
    void (async () => {
      const result = await frameViewClientResult.getDiagnosticsSnapshot();
      if (Result.isError(result)) {
        console.error('[frameView:get-diagnostics-snapshot]', result.error);
        scheduleStatusReset('Diagnostics unavailable');
        return;
      }

      const report = buildDiagnosticsReport(result.value, {
        folderName: rootPath ? toDisplayName(rootPath) : null,
        itemCount: mediaEntryCount,
        recursive,
        scanState,
      });
      await navigator.clipboard.writeText(report);
      await refreshSettingsPanelData();
    })();
  }, [mediaEntryCount, recursive, refreshSettingsPanelData, rootPath, scanState]);

  const refreshDiagnosticsAction = useCallback((): void => {
    void refreshSettingsPanelData();
  }, [refreshSettingsPanelData]);

  const clearThumbnailCacheAction = useCallback((): void => {
    void (async () => {
      const result = await frameViewClientResult.clearThumbnailCache();
      const errorMessage = getFrameViewErrorMessage(result, 'Thumbnail cache clear failed');
      if (errorMessage) {
        console.error(
          '[frameView:clear-thumbnail-cache]',
          Result.isError(result) ? result.error : null,
        );
        scheduleStatusReset(errorMessage);
        return;
      }

      await refreshSettingsPanelData();
      scheduleStatusReset('Thumbnail cache cleared');
    })();
  }, [refreshSettingsPanelData, scheduleStatusReset]);

  const clearMediaIndexAction = useCallback((): void => {
    void (async () => {
      const result = await frameViewClientResult.clearMediaIndex();
      const errorMessage = getFrameViewErrorMessage(result, 'Media index clear failed');
      if (errorMessage) {
        console.error(
          '[frameView:clear-media-index]',
          Result.isError(result) ? result.error : null,
        );
        scheduleStatusReset(errorMessage);
        return;
      }

      await refreshSettingsPanelData();
      scheduleStatusReset('Media index cleared');
    })();
  }, [refreshSettingsPanelData, scheduleStatusReset]);

  return {
    cacheStatusMessage,
    clearMediaIndexAction,
    clearThumbnailCacheAction,
    copyDiagnosticsAction,
    refreshDiagnosticsAction,
    updateSettings,
  };
}
