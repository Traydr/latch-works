import { existsSync } from 'node:fs';
import path from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import { config as loadEnv } from 'dotenv';
import { app, BrowserWindow, protocol } from 'electron';
import started from 'electron-squirrel-startup';

loadEnv();

if (['1', 'true', 'yes'].includes((process.env.FRAME_VIEW_DISABLE_GPU ?? '').toLowerCase())) {
  app.disableHardwareAcceleration();
}

import { CatalogService } from './main/catalog/CatalogService';
import { registerIpc } from './main/ipc/registerIpc';
import { buildAppMenu } from './main/menu';
import {
  MEDIA_PROTOCOL_SCHEME,
  registerMediaProtocol,
  setThumbnailDebugOptions,
  shutdownThumbnailService,
} from './main/services/mediaProtocol';
import { MediaToolsService } from './main/services/mediaToolsService';
import { SettingsService } from './main/services/settingsService';
import { persistWindowState } from './main/services/windowStatePersistence';
import { createMainWindowCloseHandler } from './main/windowLifecycle';
import type { AppCommand } from './shared/types';

if (started) {
  app.quit();
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let settingsService: SettingsService;
let catalogService: CatalogService;
let mediaToolsService: MediaToolsService;
const pendingCommands: AppCommand[] = [];

function logResultError<T, E extends { message: string }>(
  operation: string,
  result: ResultType<T, E>,
): void {
  if (Result.isError(result)) {
    console.error(`[${operation}] ${result.error.message}`);
  }
}

function queueOrSendCommand(command: AppCommand): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) {
    pendingCommands.push(command);
    return;
  }

  mainWindow.webContents.send('app:command', command);
}

function flushPendingCommands(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  while (pendingCommands.length) {
    const command = pendingCommands.shift();
    if (command) {
      mainWindow.webContents.send('app:command', command);
    }
  }
}

function extractLaunchPathFromArgv(argv: string[]): string | null {
  const executablePath = path.resolve(process.execPath);

  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) {
      continue;
    }

    const resolvedArg = path.resolve(arg);
    if (resolvedArg === executablePath) {
      continue;
    }

    if (existsSync(resolvedArg)) {
      return resolvedArg;
    }
  }

  return null;
}

async function createWindow(): Promise<void> {
  if (!mediaToolsService) {
    mediaToolsService = new MediaToolsService();
  }

  const windowIconPath = path.join(app.getAppPath(), 'media', 'frame-view-icon.png');

  if (!settingsService) {
    settingsService = new SettingsService(app.getPath('userData'));
    const initResult = await settingsService.init();
    if (Result.isError(initResult)) {
      logResultError('settings:init', initResult);
    }
  }

  setThumbnailDebugOptions(settingsService.getSettings().debug);

  if (!catalogService) {
    catalogService = new CatalogService(app.getPath('userData'), (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }

      mainWindow.webContents.send('scan:event', event);
    });
  }

  const savedBounds = settingsService.getWindowBounds();
  const savedMaximized = settingsService.getWindowMaximized();

  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1320,
    height: savedBounds?.height ?? 820,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 980,
    minHeight: 640,
    autoHideMenuBar: true,
    icon: existsSync(windowIconPath) ? windowIconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  registerIpc(mainWindow, settingsService, catalogService, mediaToolsService);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  let boundsPersistTimer: NodeJS.Timeout | null = null;

  const persistWindowBounds = (immediate = false): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const saveBounds = async (): Promise<void> => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return Promise.resolve();
      }
      const { boundsResult } = await persistWindowState(mainWindow, settingsService, {
        immediate,
      });
      if (boundsResult && Result.isError(boundsResult)) {
        logResultError('settings:update-window-bounds', boundsResult);
      }
    };

    if (immediate) {
      if (boundsPersistTimer) {
        clearTimeout(boundsPersistTimer);
        boundsPersistTimer = null;
      }
      void saveBounds();
      return;
    }

    if (boundsPersistTimer) {
      clearTimeout(boundsPersistTimer);
    }

    boundsPersistTimer = setTimeout(() => {
      boundsPersistTimer = null;
      saveBounds();
    }, 250);
  };

  const persistWindowMaximized = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    void persistWindowState(mainWindow, settingsService).then(({ maximizedResult }) => {
      if (maximizedResult && Result.isError(maximizedResult)) {
        logResultError('settings:update-window-maximized', maximizedResult);
      }
    });
  };

  if (savedMaximized) {
    mainWindow.maximize();
  }

  mainWindow.on('resize', () => persistWindowBounds(false));
  mainWindow.on('move', () => persistWindowBounds(false));
  mainWindow.on('maximize', persistWindowMaximized);
  mainWindow.on('unmaximize', persistWindowMaximized);
  mainWindow.on(
    'close',
    createMainWindowCloseHandler(mainWindow, settingsService, (operation, message) => {
      console.error(`[${operation}] ${message}`);
    }),
  );
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('did-finish-load', flushPendingCommands);
}

app.on('ready', () => {
  mediaToolsService = new MediaToolsService();
  registerMediaProtocol(app.getPath('userData'), app.getPath('sessionData'));
  buildAppMenu(queueOrSendCommand);

  if (app.isPackaged) {
    const launchPath = extractLaunchPathFromArgv(process.argv.slice(1));
    if (launchPath) {
      queueOrSendCommand({ type: 'scan-path', path: launchPath });
    }
  }

  void createWindow();
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', (_event, argv) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
  const launchPath = extractLaunchPathFromArgv(argv.slice(1));
  if (launchPath) {
    queueOrSendCommand({ type: 'scan-path', path: launchPath });
  }
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueOrSendCommand({ type: 'scan-path', path: filePath });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  catalogService?.shutdown();
  shutdownThumbnailService();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
