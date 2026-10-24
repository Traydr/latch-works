import { existsSync } from "node:fs";
import path from "node:path";
import { setLatchWorksDataFolder } from "@latch-works/app-data";
import { Result } from "better-result";
import { app, BrowserWindow, dialog, safeStorage } from "electron";
import started from "electron-squirrel-startup";

import { registerIpc } from "./main/ipc/registerIpc";
import { FileSecretStorage, fileSecretKeyPath } from "./main/services/fileSecretStorage";
import { ProfileService, type SecretStorage } from "./main/services/profileService";
import { RunService } from "./main/services/runService";

if (started) {
  app.quit();
}

// Profiles and settings live in ~/.latch-works/lockstep, with the other apps' data.
setLatchWorksDataFolder(app, { folder: "lockstep" });

app.disableHardwareAcceleration();

app.commandLine.appendSwitch("disable-gpu");

let mainWindow: BrowserWindow | null = null;

function resolveWindowIconPath(fileName: string): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), "media", fileName),
    path.join(process.resourcesPath, "media", fileName),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Unpackaged runs (e2e, development) can set `LOCKSTEP_SECRET_STORAGE=file` to keep tokens under
 * a key in Lockstep's data folder instead of the Keychain, which prompts whenever the Electron
 * binary changes and blocks unattended runs. Packaged builds always use `safeStorage`.
 */
function resolveSecretStorage(): SecretStorage {
  if (!app.isPackaged && process.env.LOCKSTEP_SECRET_STORAGE === "file") {
    return new FileSecretStorage(fileSecretKeyPath(app.getPath("userData")));
  }

  return safeStorage;
}

/**
 * Profiles, runs, and IPC live as long as the process. On macOS the app outlives its window, so a
 * run started in a closed window keeps its controller and a reopened window attaches to it.
 */
async function startServices(): Promise<void> {
  const profileService = new ProfileService(app.getPath("userData"), {
    secretStorage: resolveSecretStorage(),
  });

  const initResult = await profileService.init();

  if (Result.isError(initResult)) {
    console.error(`[profile-init] ${initResult.error.message}`);
    dialog.showErrorBox("Lockstep could not load its profiles", initResult.error.message);
  }

  const runService = new RunService(profileService, () => mainWindow);
  registerIpc(() => mainWindow, profileService, runService);
}

async function createWindow(): Promise<void> {
  const windowIconPath = resolveWindowIconPath("lockstep-icon.png");

  const window = new BrowserWindow({
    height: 800,
    icon: windowIconPath,
    // The profile rail, plan tree, and run panel need this much room side by side.
    minHeight: 520,
    minWidth: 900,
    show: false,
    title: "Lockstep",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
    width: 1100,
  });

  mainWindow = window;

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

app.whenReady().then(async () => {
  await startServices();
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
