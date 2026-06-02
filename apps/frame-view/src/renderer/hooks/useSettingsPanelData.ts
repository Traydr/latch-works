import { Result } from 'better-result';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiagnosticsSnapshot, MediaIndexStats, MediaToolsStatus } from '../../shared/types';
import { frameViewClient, frameViewClientResult } from '../services/frameViewClient';

interface UseSettingsPanelDataResult {
  diagnosticsSnapshot: DiagnosticsSnapshot | null;
  mediaIndexStats: MediaIndexStats | null;
  mediaToolsStatus: MediaToolsStatus | null;
  refreshSettingsPanelData: () => Promise<void>;
}

export function useSettingsPanelData(enabled: boolean): UseSettingsPanelDataResult {
  const [mediaIndexStats, setMediaIndexStats] = useState<MediaIndexStats | null>(null);
  const [mediaToolsStatus, setMediaToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const requestIdRef = useRef(0);

  const refreshSettingsPanelData = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;

    const applyIfCurrent = <T>(setter: (value: T | null) => void, value: T | null): void => {
      if (requestIdRef.current !== requestId) {
        return;
      }

      setter(value);
    };

    const [nextMediaIndexStats, mediaToolsResult, diagnosticsResult] = await Promise.all([
      frameViewClient.getMediaIndexStats().catch((error) => {
        console.error('[frameView:get-media-index-stats]', error);
        return null;
      }),
      frameViewClientResult.getMediaToolsStatus(),
      frameViewClientResult.getDiagnosticsSnapshot(),
    ]);

    if (Result.isError(mediaToolsResult)) {
      console.error('[frameView:get-media-tools-status]', mediaToolsResult.error);
    }

    if (Result.isError(diagnosticsResult)) {
      console.error('[frameView:get-diagnostics-snapshot]', diagnosticsResult.error);
    }

    applyIfCurrent(setMediaIndexStats, nextMediaIndexStats);
    applyIfCurrent(
      setMediaToolsStatus,
      Result.isOk(mediaToolsResult) ? mediaToolsResult.value : null,
    );
    applyIfCurrent(
      setDiagnosticsSnapshot,
      Result.isOk(diagnosticsResult) ? diagnosticsResult.value : null,
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void refreshSettingsPanelData();

    return () => {
      requestIdRef.current += 1;
    };
  }, [enabled, refreshSettingsPanelData]);

  return {
    diagnosticsSnapshot,
    mediaIndexStats,
    mediaToolsStatus,
    refreshSettingsPanelData,
  };
}
