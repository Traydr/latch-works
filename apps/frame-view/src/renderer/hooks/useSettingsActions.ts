import { Result } from 'better-result';
import { useCallback, useRef, useState } from 'react';

import type { AppSettings, AppSettingsPatch, RootGalleryPreferences } from '../../shared/types';
import { frameViewClientResult } from '../services/frameViewClient';
import { useAppStore } from '../store/useAppStore';
import { buildDiagnosticsReport } from '../utils/diagnostics';
import { getFrameViewErrorMessage } from '../utils/frameViewResult';
import { toDisplayName } from '../utils/path';
import {
  createRootGalleryPreferencesPatch,
  getRootGalleryPreferences,
} from '../utils/rootPreferences';

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
  /**
   * Changes one folder's gallery preferences, applied to the settings as they stand when the
   * change's turn in the save queue comes, so quick changes build on each other instead of
   * replacing each other. Resolves with the folder's saved preferences, or null if saving failed.
   */
  updateRootGalleryPreferences: (
    folderPath: string,
    change: (preferences: RootGalleryPreferences) => RootGalleryPreferences,
  ) => Promise<RootGalleryPreferences | null>;
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
  const settingsUpdateQueueRef = useRef<Promise<void> | null>(null);

  const scheduleStatusReset = useCallback((message: string): void => {
    setCacheStatusMessage(message);
    window.setTimeout(() => {
      setCacheStatusMessage(null);
    }, 2200);
  }, []);

  const enqueueSettingsUpdate = useCallback(
    async (buildPatch: () => AppSettingsPatch): Promise<AppSettings | null> => {
      const runUpdate = async (): Promise<AppSettings | null> => {
        const patch = buildPatch();
        const result = await frameViewClientResult.updateSettings(patch);

        if (Result.isError(result)) {
          console.error('[frameView:update-settings]', result.error);
          scheduleStatusReset(`Settings update failed: ${result.error.message}`);

          return null;
        }

        const updated = result.value;
        initializeSettings(updated);

        // Repeats the latest scan request with the new filters, since the user may have changed
        // folder or mode while this update waited. Not awaited: a scan request waits for a running
        // scan to wind down, and later settings updates must not queue behind it.
        const { requestedScan } = useAppStore.getState();

        if (requestedScan && patch.filters) {
          void runScan(requestedScan.rootPath, {
            recursive: requestedScan.recursive,
            filters: updated.filters,
            excludedRootChildPaths: requestedScan.excludedRootChildPaths,
          });
        }

        return updated;
      };

      const currentQueue = settingsUpdateQueueRef.current ?? Promise.resolve();
      const scheduledUpdate = currentQueue.then(runUpdate, runUpdate);
      settingsUpdateQueueRef.current = scheduledUpdate.then(() => undefined);

      return scheduledUpdate;
    },
    [initializeSettings, runScan, scheduleStatusReset],
  );

  const updateSettings = useCallback(
    async (patch: AppSettingsPatch): Promise<void> => {
      await enqueueSettingsUpdate(() => patch);
    },
    [enqueueSettingsUpdate],
  );

  const updateRootGalleryPreferences = useCallback(
    async (
      folderPath: string,
      change: (preferences: RootGalleryPreferences) => RootGalleryPreferences,
    ): Promise<RootGalleryPreferences | null> => {
      const updated = await enqueueSettingsUpdate(() => {
        // The store holds every earlier queued update's saved result by now.
        const latest = useAppStore.getState().settings;

        return createRootGalleryPreferencesPatch(
          latest,
          folderPath,
          change(getRootGalleryPreferences(latest, folderPath)),
        );
      });

      return updated ? getRootGalleryPreferences(updated, folderPath) : null;
    },
    [enqueueSettingsUpdate],
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
    updateRootGalleryPreferences,
    updateSettings,
  };
}
