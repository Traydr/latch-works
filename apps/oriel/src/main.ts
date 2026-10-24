import { existsSync } from "node:fs";
import path from "node:path";

import { latchWorksModeFolder, setLatchWorksDataFolder } from "@latch-works/app-data";
import { app, BrowserWindow, ipcMain, Menu } from "electron";

import { appMenu, modeMenuItemId } from "./main/menu";
import type { ModeHost } from "./main/mode";
import { startSync } from "./modes/sync/main/start";
import { type Json, ModeIdSchema, ShellChannels, type ShellCommand } from "./shared/shell";

// The shell's own window state and Chromium storage live in ~/.latch-works/oriel. Each mode keeps
// the folder its standalone app used beside it. Before the single-instance lock, which keys on
// this folder.
setLatchWorksDataFolder(app, { folder: "oriel" });

// Hardware acceleration stays on: Tidy's transcoder encodes on the GPU's media engines. A machine
// with no usable GPU (a cloud VM) turns it off.
if (["1", "true", "yes"].includes((process.env.ORIEL_DISABLE_GPU ?? "").toLowerCase())) {
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null = null;

const modes: ModeHost[] = [];

/** Set while the window is hidden until running work ends; the app then quits. */
let pendingQuit: NodeJS.Timeout | null = null;

function busy(): boolean {
  return modes.some((mode) => mode.busy());
}

/**
 * Closing the window or quitting while a push or a Glazier change runs hides the window instead,
 * and quits once the work has finished; quitting again in the meantime quits at once. Returns
 * whether it deferred.
 */
function deferQuitWhileBusy(): boolean {
  if (pendingQuit !== null || !busy()) {
    return false;
  }

  mainWindow?.hide();
  pendingQuit = setInterval(() => {
    if (!busy()) {
      app.quit();
    }
  }, 1000);

  return true;
}

/** Brings the window back, which also calls off a quit waiting for work to end. */
function showWindow(): void {
  if (pendingQuit !== null) {
    clearInterval(pendingQuit);
    pendingQuit = null;
  }

  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
  }
}

function showProgress(progress: number | null): void {
  mainWindow?.setProgressBar(progress ?? -1);
}

function resolveWindowIconPath(fileName: string): string | undefined {
  return [
    path.join(app.getAppPath(), "media", fileName),
    path.join(process.resourcesPath, "media", fileName),
  ].find((candidate) => existsSync(candidate));
}

function send(command: ShellCommand): void {
  mainWindow?.webContents.send(ShellChannels.command, command);
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    height: 860,
    width: 1320,
    minHeight: 640,
    minWidth: 960,
    show: false,
    title: "Oriel",
    // On macOS the window buttons sit over the sidebar's top strip; Windows and Linux keep their
    // native frame.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    icon: resolveWindowIconPath("oriel-icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
  });

  mainWindow = window;

  window.on("close", (event) => {
    if (deferQuitWhileBusy()) {
      event.preventDefault();
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.once("ready-to-show", () => window.show());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });

  app.on("before-quit", (event) => {
    if (deferQuitWhileBusy()) {
      event.preventDefault();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(appMenu({ appName: app.name, packaged: app.isPackaged, send })),
    );

    ipcMain.on(ShellChannels.setMode, (_event, value: Json) => {
      const mode = ModeIdSchema.safeParse(value);

      if (!mode.success) {
        console.warn(
          `[oriel:main] ignored an unknown mode from the window: ${JSON.stringify(value)}`,
        );

        return;
      }

      const item = Menu.getApplicationMenu()?.getMenuItemById(modeMenuItemId(mode.data));

      if (item) {
        item.checked = true;
      }
    });

    // Sync is cheap and starts at once: a run must outlive the window.
    modes.push(
      await startSync({
        dataDir: latchWorksModeFolder(app, { folder: "lockstep", legacyName: "Lockstep" }),
        window: () => mainWindow,
        onProgress: showProgress,
      }),
    );

    void createWindow();

    app.on("activate", () => {
      if (mainWindow) {
        showWindow();
      } else {
        void createWindow();
      }
    });
  });
}

// Oriel is one window: closing it quits, on macOS too.
app.on("window-all-closed", () => {
  app.quit();
});
