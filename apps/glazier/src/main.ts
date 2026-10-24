import { existsSync } from "node:fs";
import path from "node:path";

import { app, BrowserWindow, Menu } from "electron";
import started from "electron-squirrel-startup";

import { EngineHost } from "./main/engine-host";
import { registerIpc } from "./main/ipc";
import { handleMediaProtocol, registerMediaScheme } from "./main/media-protocol";
import { RendererChannels } from "./shared/messages";

if (started) {
  app.quit();
}

// Unlike the other Latch Works apps, hardware acceleration stays on: the transcoder window's
// WebCodecs encoders run on the GPU and media engines it provides.
registerMediaScheme();

let mainWindow: BrowserWindow | null = null;

const host = new EngineHost({
  dataDir: app.getPath("userData"),
  packaged: app.isPackaged,
  onEvent: (event) => {
    mainWindow?.webContents.send(RendererChannels.event, event);
  },
});

function resolveWindowIconPath(fileName: string): string | undefined {
  return [
    path.join(app.getAppPath(), "media", fileName),
    path.join(process.resourcesPath, "media", fileName),
  ].find((candidate) => existsSync(candidate));
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    height: 860,
    width: 1320,
    minHeight: 600,
    minWidth: 980,
    show: false,
    title: "Glazier",
    icon: resolveWindowIconPath("glazier-icon.png"),
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

    // Glazier is one window. Closing it quits, on macOS too: the engine, its workers and the
    // hidden transcoder window would otherwise keep running with nothing on screen.
    app.quit();
  });

  window.once("ready-to-show", () => window.show());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
  }

  handleMediaProtocol(host);
  registerIpc(host, () => mainWindow);
  // The window comes first so it shows at once; engine calls wait for the engine themselves.
  void createWindow();
  await host.start().catch((error: Error) => {
    console.error(`[glazier:main] the engine did not start: ${error.message}`);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length === 0) {
      void createWindow();
    }
  });
});

app.on("will-quit", () => {
  host.dispose();
});
