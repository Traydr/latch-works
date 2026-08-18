import { Result } from 'better-result';

import {
  type PersistableWindow,
  persistWindowState,
  type WindowStateSettings,
} from './services/windowStatePersistence';

/** The window surface the close handler drives while it saves state. */
export interface ClosableWindow extends PersistableWindow {
  destroy: () => void;
}

/** The close event only has to be deferred until the window state is on disk. */
export interface DeferrableCloseEvent {
  preventDefault: () => void;
}

export function createMainWindowCloseHandler(
  mainWindow: ClosableWindow,
  settingsService: WindowStateSettings,
  logErrorMessage: (operation: string, message: string) => void,
): (event: DeferrableCloseEvent) => void {
  let isClosingWindow = false;

  return (event: DeferrableCloseEvent): void => {
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
