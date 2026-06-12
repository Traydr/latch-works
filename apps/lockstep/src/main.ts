import path from "node:path";
import { Result } from "better-result";
import { app, BrowserWindow } from "electron";
import started from "electron-squirrel-startup";

import { registerIpc } from "./main/ipc/registerIpc";
import { ProfileService } from "./main/services/profileService";
import { RunService } from "./main/services/runService";

if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let profileService: ProfileService;
let runService: RunService;

async function createWindow(): Promise<void> {
  profileService = new ProfileService(app.getPath("userData"));
  const initResult = await profileService.init();
  if (Result.isError(initResult)) {
    console.error(`[profile-init] ${initResult.error.message}`);
  }

  runService = new RunService(profileService, () => mainWindow);

  mainWindow = new BrowserWindow({
    height: 800,
    show: false,
    title: "Lockstep",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
    },
    width: 1100,
  });

  registerIpc(mainWindow, profileService, runService);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

app.whenReady().then(() => {
  void createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
