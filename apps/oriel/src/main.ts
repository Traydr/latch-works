import { existsSync } from "node:fs";
import path from "node:path";

import { latchWorksModeFolder, setLatchWorksDataFolder } from "@latch-works/app-data";
import { app, BrowserWindow, ipcMain, Menu, protocol, screen } from "electron";

import { appMenu } from "./main/menu";
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

  app.on("will-quit", () => {
    for (const mode of modes.values()) {
      mode.dispose?.();
    }
  });

  app.whenReady().then(async () => {
    // A mode starts what it needs the first time the window shows it, and the menu follows the
    // mode on screen.
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

    view = await startView({
      dataDir: latchWorksModeFolder(app, { folder: "frame-view", legacyName: "Frame View" }),
      window: () => mainWindow,
      onProgress: reportProgress("view"),
    });
    modes.set("view", view);

    for (const launchPath of heldLaunchPaths.splice(0)) {
      view.openPath(launchPath);
    }

    // Sync is cheap and starts at once: a run must outlive the window.
    modes.set(
      "sync",
      await startSync({
        dataDir: latchWorksModeFolder(app, { folder: "lockstep", legacyName: "Lockstep" }),
        window: () => mainWindow,
        onProgress: reportProgress("sync"),
      }),
    );

    modes.set(
      "tidy",
      startTidy({
        dataDir: latchWorksModeFolder(app, { folder: "glazier", legacyName: "Glazier" }),
        window: () => mainWindow,
        onProgress: reportProgress("tidy"),
        packaged: app.isPackaged,
      }),
    );

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
