import { existsSync } from "node:fs";
import path from "node:path";

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import started from "electron-squirrel-startup";

import { EngineHost } from "./main/engine-host";
import { registerIpc } from "./main/ipc";
import { handleMediaProtocol, registerMediaScheme } from "./main/media-protocol";
import { type AppCommand, RendererChannels } from "./shared/messages";

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
    minHeight: 640,
    minWidth: 960,
    show: false,
    title: "Glazier",
    // On macOS the window buttons sit over the sidebar's top bar, as in Frame View and T3 Code;
    // the page title (the root's name) still names the window in Mission Control and the Window
    // menu. Windows and Linux keep their native frame.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
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

function send(command: AppCommand): () => void {
  return () => mainWindow?.webContents.send(RendererChannels.command, command);
}

/**
 * The app menu. Its commands go to the renderer, which decides what they mean where focus is:
 * Undo and Select All act on a text field when one is focused, and on files otherwise.
 */
function appMenu(): MenuItemConstructorOptions[] {
  const mac = process.platform === "darwin";

  const settings: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: send("settings"),
  };

  const views = [
    ["Overview", "view:overview"],
    ["Duplicates", "view:duplicates"],
    ["Convert", "view:convert"],
    ["Clean Up", "view:cleanup"],
    ["Library", "view:library"],
    ["History", "view:history"],
    ["Holding", "view:holding"],
  ] as const satisfies ReadonlyArray<readonly [string, AppCommand]>;

  return [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ] satisfies MenuItemConstructorOptions[],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "Add Folder…", accelerator: "CmdOrCtrl+O", click: send("add-root") },
        { label: "Rescan", accelerator: "CmdOrCtrl+R", click: send("rescan") },
        { type: "separator" },
        ...(mac ? [{ role: "close" } as const] : [settings, { type: "separator" } as const]),
        ...(mac ? [] : [{ role: "quit" } as const]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: send("undo") },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { label: "Select All", accelerator: "CmdOrCtrl+A", click: send("select-all") },
        { type: "separator" },
        { label: "Find", accelerator: "CmdOrCtrl+F", click: send("find") },
      ],
    },
    {
      label: "View",
      submenu: [
        ...views.map(([label, command], index) => ({
          label,
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: send(command),
        })),
        { type: "separator" },
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+\\", click: send("toggle-sidebar") },
        { role: "togglefullscreen" },
        ...(app.isPackaged
          ? []
          : [
              { type: "separator" } as const,
              { role: "reload" } as const,
              { role: "toggleDevTools" } as const,
            ]),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Keyboard Shortcuts", click: send("shortcuts") }],
    },
  ];
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu()));

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
