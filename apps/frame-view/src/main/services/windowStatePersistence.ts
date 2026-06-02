import type { Rectangle } from 'electron';

import type { SettingsService } from './settingsService';

interface PersistableWindow {
  getBounds: () => Rectangle;
  getNormalBounds: () => Rectangle;
  isDestroyed: () => boolean;
  isMaximized: () => boolean;
}

interface PersistWindowStateResult {
  boundsResult: Awaited<ReturnType<SettingsService['updateWindowBounds']>> | null;
  flushResult: Awaited<ReturnType<SettingsService['flushNowSync']>> | null;
  maximizedResult: Awaited<ReturnType<SettingsService['updateWindowMaximized']>> | null;
}

export async function persistWindowState(
  window: PersistableWindow,
  settingsService: SettingsService,
  options?: {
    flush?: boolean;
    immediate?: boolean;
  },
): Promise<PersistWindowStateResult> {
  if (window.isDestroyed()) {
    return {
      boundsResult: null,
      flushResult: null,
      maximizedResult: null,
    };
  }

  const persistOptions = options?.immediate ? { immediate: true } : undefined;
  const maximizedResult = await settingsService.updateWindowMaximized(
    window.isMaximized(),
    persistOptions,
  );
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  const boundsResult = await settingsService.updateWindowBounds(bounds, persistOptions);
  const flushResult = options?.flush ? await settingsService.flushNowSync() : null;

  return {
    boundsResult,
    flushResult,
    maximizedResult,
  };
}
