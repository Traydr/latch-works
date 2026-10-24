import { existsSync } from "node:fs";
import path from "node:path";

import { setLatchWorksDataFolder } from "@latch-works/app-data";
import { app, BrowserWindow, ipcMain, Menu } from "electron";

import { appMenu, modeMenuItemId } from "./main/menu";
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
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

    void createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

// Oriel is one window: closing it quits, on macOS too.
app.on("window-all-closed", () => {
  app.quit();
});
