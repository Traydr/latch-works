import { Result } from 'better-result';
import type { BrowserWindow } from 'electron';

import type { SettingsService } from './services/settingsService';
import { persistWindowState } from './services/windowStatePersistence';

export function createMainWindowCloseHandler(
  mainWindow: BrowserWindow,
  settingsService: SettingsService,
  logErrorMessage: (operation: string, message: string) => void,
): (event: Electron.Event) => void {
  let isClosingWindow = false;

  return (event: Electron.Event): void => {
    if (isClosingWindow) {
      return;
    }

    isClosingWindow = true;
    event.preventDefault();

    void (async () => {
      const { maximizedResult, boundsResult, flushResult } = await persistWindowState(
        mainWindow,
        settingsService,
        {
          immediate: true,
          flush: true,
        },
      );

      if (maximizedResult && Result.isError(maximizedResult)) {
        logErrorMessage('settings:update-window-maximized', maximizedResult.error.message);
      }

      if (boundsResult && Result.isError(boundsResult)) {
        logErrorMessage('settings:update-window-bounds', boundsResult.error.message);
      }

      if (flushResult && Result.isError(flushResult)) {
        logErrorMessage('settings:flush', flushResult.error.message);
      }

      if (!mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
    })();
  };
}
