import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { latchWorksModeFolder, setLatchWorksDataFolder } from "@latch-works/app-data";
import { app, BrowserWindow, ipcMain, Menu, protocol, screen, shell } from "electron";
import { z } from "zod";

import { type FolderSources, glazierRoots, isInside, knownFolders } from "./main/folders";
import { appMenu } from "./main/menu";
import {
  type MigrationFolders,
  migrateOldApps,
  readMigrationReport,
  waitForOldAppsToQuit,
} from "./main/migration";
import type { ModeContext, ModeHost } from "./main/mode";
import { readWindowState, rememberWindowState } from "./main/window-state";
import { startSync } from "./modes/sync/main/start";
import { TIDY_MEDIA_SCHEME } from "./modes/tidy/main/media-protocol";
import { startTidy } from "./modes/tidy/main/start";
import { extractLaunchPathFromArgv, startView, VIEW_MEDIA_SCHEME } from "./modes/view/main/start";
import {
  type Json,
  type ModeId,
  ModeIdSchema,
  ShellChannels,
  type ShellCommand,
} from "./shared/shell";

// The shell's own window state and Chromium storage live in ~/.latch-works/oriel. Each mode keeps
// the folder its standalone app used beside it. Before the single-instance lock, which keys on
// this folder.
setLatchWorksDataFolder(app, { folder: "oriel" });

// Hardware acceleration stays on: Tidy's transcoder encodes on the GPU's media engines. A machine
// with no usable GPU (a cloud VM) turns it off.
if (["1", "true", "yes"].includes((process.env.ORIEL_DISABLE_GPU ?? "").toLowerCase())) {
  app.disableHardwareAcceleration();
}

// Every mode's scheme, in the one call Electron allows before the app is ready.
protocol.registerSchemesAsPrivileged([VIEW_MEDIA_SCHEME, TIDY_MEDIA_SCHEME]);

let mainWindow: BrowserWindow | null = null;

const modes = new Map<ModeId, ModeHost>();

/** View, which also opens the paths the OS hands the app. */
let view: Awaited<ReturnType<typeof startView>> | null = null;

let sync: Awaited<ReturnType<typeof startSync>> | null = null;

/** Set once the modes' folders are known. */
let folders: MigrationFolders | null = null;

/** False under `--user-data-dir` (the e2e suite), whose folders are not the owner's real data. */
const ownersData = !app.commandLine.hasSwitch("user-data-dir");

/** File › Import from the Old Apps…: the first start's migration again, then a fresh window. */
async function importOldApps(): Promise<void> {
  if (!folders || !view || !sync || (ownersData && !(await waitForOldAppsToQuit()))) {
    return;
  }

  await migrateOldApps(folders, { view, sync }, { offerRemoval: ownersData });
  mainWindow?.reload();
}

/** Shell commands wait until the window has mounted and is listening; it says so with its mode. */
let windowListening = false;

const heldCommands: ShellCommand[] = [];

/** Paths the OS handed over before View had started (macOS opens a file before the app is ready). */
const heldLaunchPaths: string[] = [];

/** The mode the window shows, as it last reported. */
let currentMode: ModeId = "view";

/** Each mode's running work, from 0 to 1, for the Dock icon's progress bar. */
const progress = new Map<ModeId, number>();

/** Set while the window is hidden until running work ends; the app then quits. */
let pendingQuit: NodeJS.Timeout | null = null;

function busy(): boolean {
  return [...modes.values()].some((mode) => mode.busy());
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

/** The Dock icon (the taskbar button on Windows) shows the running work's progress. */
function reportProgress(mode: ModeId): ModeContext["onProgress"] {
  return (value) => {
    if (value === null) {
      progress.delete(mode);
    } else {
      progress.set(mode, value);
    }

    const values = [...progress.values()];

    mainWindow?.setProgressBar(
      values.length === 0 ? -1 : values.reduce((sum, each) => sum + each, 0) / values.length,
    );
  };
}

function resolveWindowIconPath(fileName: string): string | undefined {
  return [
    path.join(app.getAppPath(), "media", fileName),
    path.join(process.resourcesPath, "media", fileName),
  ].find((candidate) => existsSync(candidate));
}

function send(command: ShellCommand): void {
  if (!mainWindow || !windowListening) {
    heldCommands.push(command);

    return;
  }

  mainWindow.webContents.send(ShellChannels.command, command);
}

/** Shows View and opens a path the OS handed the app there. */
function openInView(candidatePath: string): void {
  send({ type: "mode", mode: "view" });

  if (view) {
    view.openPath(candidatePath);
  } else {
    heldLaunchPaths.push(candidatePath);
  }

  showWindow();
}

/** Where each mode keeps its folders; empty until the modes have started. */
function folderSources(): FolderSources {
  return {
    view: () => view?.lastFolder() ?? null,
    tidy: () => (folders ? glazierRoots(folders.glazier) : []),
    sync: () => sync?.sourceRoots() ?? [],
    migrated: () => (folders ? (readMigrationReport(folders.oriel)?.folders ?? []) : []),
  };
}

/**
 * Opens a file or folder another mode showed, in View. View scans only folders the owner chose,
 * so the path, symlinks resolved, has to sit inside a folder one of the modes works on.
 */
async function handOffToView(value: Json): Promise<boolean> {
  const target = z.string().min(1).safeParse(value);

  if (!target.success || !path.isAbsolute(target.data) || !view) {
    return false;
  }

  const real = await realpath(target.data).catch(() => null);

  if (real === null) {
    return false;
  }

  const roots = await Promise.all(
    knownFolders(folderSources()).map((folder) => realpath(folder.path).catch(() => null)),
  );

  if (!roots.some((root) => root !== null && isInside(root, real))) {
    console.warn("[oriel:main] View was asked to open a path outside every known folder");

    return false;
  }

  view.openPath(target.data);

  return true;
}

/** The saved bounds, unless no display holds them any more (a monitor since unplugged). */
function restoredBounds(): Partial<Electron.Rectangle> {
  const state = readWindowState(app.getPath("userData"));

  if (!state) {
    return { width: 1320, height: 860 };
  }

  const area = screen.getDisplayMatching(state.bounds).workArea;

  const visible =
    state.bounds.x < area.x + area.width &&
    state.bounds.x + state.bounds.width > area.x &&
    state.bounds.y < area.y + area.height &&
    state.bounds.y + state.bounds.height > area.y;

  return visible ? state.bounds : { width: state.bounds.width, height: state.bounds.height };
}

/** Rebuilds the app menu around the mode on screen. */
function showMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenu({
        appName: app.name,
        packaged: app.isPackaged,
        mode: currentMode,
        modeMenu: modes.get(currentMode)?.menu,
        send,
        importOldApps: () => void importOldApps(),
      }),
    ),
  );
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    ...restoredBounds(),
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
  windowListening = false;

  const maximized = readWindowState(app.getPath("userData"))?.maximized ?? false;

  rememberWindowState(window, app.getPath("userData"));
  view?.attachWindow(window);

  window.on("close", (event) => {
    if (deferQuitWhileBusy()) {
      event.preventDefault();
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      windowListening = false;
    }

    // Oriel is one window: closing it quits, on macOS too. Tidy's hidden transcoder window would
    // otherwise keep the app running with nothing on screen.
    app.quit();
  });

  window.once("ready-to-show", () => {
    if (maximized) {
      window.maximize();
    }

    window.show();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const launchPath = extractLaunchPathFromArgv(argv.slice(1));

    if (launchPath) {
      openInView(launchPath);
    } else {
      showWindow();
    }
  });

  // A file or folder dropped on the Dock icon, or opened with Oriel from Finder.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    openInView(filePath);
  });

  app.on("before-quit", (event) => {
    if (deferQuitWhileBusy()) {
      event.preventDefault();
    }
  });

  // Oriel quits when its own window closes (see `createWindow`). Without a listener here,
  // Electron would also quit whenever its other windows (the migration's helpers, Tidy's
  // transcoder) happen to be the last ones open.
  app.on("window-all-closed", () => undefined);

  app.on("will-quit", () => {
    for (const mode of modes.values()) {
      mode.dispose?.();
    }
  });

  app.whenReady().then(async () => {
    // A mode starts what it needs the first time the window shows it, and the menu follows the
    // mode on screen.
    ipcMain.handle(ShellChannels.about, () => ({
      version: app.getVersion(),
      dataFolder: path.dirname(app.getPath("userData")),
    }));
    ipcMain.on(ShellChannels.importOldApps, () => void importOldApps());
    ipcMain.on(ShellChannels.revealDataFolder, () => {
      void shell.openPath(path.dirname(app.getPath("userData")));
    });
    // A folder since moved or deleted is not offered.
    ipcMain.handle(ShellChannels.folders, () =>
      knownFolders(folderSources()).filter((folder) => existsSync(folder.path)),
    );
    ipcMain.handle(ShellChannels.openInView, (_event, value: Json) => handOffToView(value));

    ipcMain.on(ShellChannels.setMode, (_event, value: Json) => {
      const mode = ModeIdSchema.safeParse(value);

      if (!mode.success) {
        console.warn(
          `[oriel:main] ignored an unknown mode from the window: ${JSON.stringify(value)}`,
        );

        return;
      }

      currentMode = mode.data;
      modes.get(currentMode)?.activate?.();
      showMenu();

      if (!windowListening) {
        windowListening = true;

        for (const command of heldCommands.splice(0)) {
          send(command);
        }
      }
    });

    // The old apps open the same catalogs and settings, so none may run beside Oriel.
    if (ownersData && !(await waitForOldAppsToQuit())) {
      app.quit();

      return;
    }

    const modeFolders: MigrationFolders = {
      oriel: app.getPath("userData"),
      frameView: latchWorksModeFolder(app, { folder: "frame-view", legacyName: "Frame View" }),
      glazier: latchWorksModeFolder(app, { folder: "glazier", legacyName: "Glazier" }),
      lockstep: latchWorksModeFolder(app, { folder: "lockstep", legacyName: "Lockstep" }),
    };

    folders = modeFolders;

    view = await startView({
      dataDir: modeFolders.frameView,
      window: () => mainWindow,
      onProgress: reportProgress("view"),
    });
    modes.set("view", view);

    for (const launchPath of heldLaunchPaths.splice(0)) {
      view.openPath(launchPath);
    }

    // Sync is cheap and starts at once: a run must outlive the window.
    sync = await startSync({
      dataDir: modeFolders.lockstep,
      window: () => mainWindow,
      onProgress: reportProgress("sync"),
    });
    modes.set("sync", sync);

    modes.set(
      "tidy",
      startTidy({
        dataDir: modeFolders.glazier,
        window: () => mainWindow,
        onProgress: reportProgress("tidy"),
        packaged: app.isPackaged,
      }),
    );

    // The first start brings the old apps' data in before the window reads it.
    if (readMigrationReport(modeFolders.oriel) === null) {
      await migrateOldApps(modeFolders, { view, sync }, { offerRemoval: ownersData });
    }

    showMenu();

    if (app.isPackaged) {
      const launchPath = extractLaunchPathFromArgv(process.argv.slice(1));

      if (launchPath) {
        openInView(launchPath);
      }
    }

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
