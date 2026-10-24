import { existsSync } from "node:fs";
import path from "node:path";

import { Result } from "better-result";
import type { BrowserWindow, CustomScheme } from "electron";

import type { ModeContext, ModeHost } from "../../../main/mode";
import type { WindowState } from "../../../main/window-state";
import { ViewChannels } from "../shared/ipcContracts";
import type { AppCommand } from "../shared/types";
import { CatalogService } from "./catalog/CatalogService";
import { ScanQueue } from "./catalog/ScanQueue";
import { createElectronIpcRuntime, registerIpc } from "./ipc/registerIpc";
import { viewMenu } from "./menu";
import { resolveFolderPath } from "./services/folderService";
import {
  authorizeRememberedMediaRoot,
  grantChosenMediaRoot,
  MEDIA_PROTOCOL_SCHEME,
  registerMediaProtocol,
  setThumbnailDebugOptions,
  shutdownThumbnailService,
} from "./services/mediaProtocol";
import { MediaToolsService } from "./services/mediaToolsService";
import { SettingsService } from "./services/settingsService";

/** View's scheme, for the shell's one `registerSchemesAsPrivileged` call before the app is ready. */
export const VIEW_MEDIA_SCHEME = {
  scheme: MEDIA_PROTOCOL_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
} as const satisfies CustomScheme;

/** The first argument that names an existing file or folder, skipping flags and the executable. */
export function extractLaunchPathFromArgv(argv: readonly string[]): string | null {
  const executablePath = path.resolve(process.execPath);

  for (const arg of argv) {
    if (!arg || arg.startsWith("-")) {
      continue;
    }

    const resolvedArg = path.resolve(arg);

    if (resolvedArg !== executablePath && existsSync(resolvedArg)) {
      return resolvedArg;
    }
  }

  return null;
}

interface ViewHost extends ModeHost {
  /**
   * Opens a path the OS handed the app (launch argv, a second launch, macOS `open-file`). Like
   * the native dialog, this is the owner's choice, so View authorizes the folder itself (a file's
   * parent folder) before asking the window to scan it. Paths open in the order given.
   */
  openPath(candidatePath: string): void;
  /** Sends the commands held for the window once it has loaded. */
  attachWindow(window: BrowserWindow): void;
  /** Frame View's saved window, theme and remembered folder, for the first start's migration. */
  savedWindow(): WindowState | null;
  theme(): "system" | "light" | "dark";
  lastFolder(): string | null;
}

/**
 * Starts View, Frame View as one of Oriel's modes: its settings, catalog and scan queue, IPC and
 * media protocol. The catalog and thumbnail workers start with the first scan and thumbnail.
 */
export async function startView({ dataDir, window }: ModeContext): Promise<ViewHost> {
  const mediaToolsService = new MediaToolsService();

  // The media index and the thumbnail cache both stay in Frame View's folder.
  registerMediaProtocol(dataDir, dataDir);

  const settingsService = new SettingsService(dataDir);
  const initResult = await settingsService.init();

  if (Result.isError(initResult)) {
    console.error(`[oriel:view] settings: ${initResult.error.message}`);
  }

  const settings = settingsService.getSettings();
  await authorizeRememberedMediaRoot(settings);
  setThumbnailDebugOptions(settings.debug);

  const catalogService: CatalogService = new CatalogService(dataDir, (event) => {
    const target = window();

    // Once a newer request is queued, the running scan is being cancelled and what it still
    // reports is stale: only the newest request's scan reaches the window.
    if (!target || target.isDestroyed() || !scanQueue.isRunningLatest()) {
      return;
    }

    target.webContents.send(ViewChannels.scanEvent, event);
  });

  // A failed cancel or wait means the catalog worker exited, so no scan is running either way.
  const scanQueue = new ScanQueue({
    cancelScan: async () => {
      await catalogService.cancelScan();
    },
    waitForScan: async () => {
      await catalogService.waitForScan();
    },
  });

  registerIpc(
    createElectronIpcRuntime(window),
    settingsService,
    catalogService,
    mediaToolsService,
    scanQueue,
  );

  const pendingCommands: AppCommand[] = [];

  /** Sends a command, or holds it until the window's page has loaded (a cold start's launch path). */
  const sendCommand = (command: AppCommand): void => {
    const target = window();

    if (!target || target.isDestroyed() || target.webContents.isLoadingMainFrame()) {
      pendingCommands.push(command);

      return;
    }

    target.webContents.send(ViewChannels.command, command);
  };

  let pathsOpened = Promise.resolve();

  return {
    busy: () => false,
    menu: viewMenu(sendCommand),
    attachWindow: (target) => {
      target.webContents.on("did-finish-load", () => {
        for (const command of pendingCommands.splice(0)) {
          target.webContents.send(ViewChannels.command, command);
        }
      });
    },
    openPath: (candidatePath) => {
      pathsOpened = pathsOpened.then(async () => {
        const resolvedPath = await resolveFolderPath(candidatePath);

        if (Result.isError(resolvedPath)) {
          console.error(`[oriel:view] launch path: ${resolvedPath.error.message}`);

          return;
        }

        if (!resolvedPath.value) {
          return;
        }

        await grantChosenMediaRoot(resolvedPath.value);
        sendCommand({ type: "scan-path", path: resolvedPath.value });
      });
    },
    dispose: () => {
      catalogService.shutdown();
      shutdownThumbnailService();
    },
    savedWindow: () => {
      const bounds = settingsService.getWindowBounds();

      return bounds ? { bounds, maximized: settingsService.getWindowMaximized() } : null;
    },
    theme: () => settingsService.getSettings().theme,
    lastFolder: () => settingsService.getSettings().lastFolderPath,
  };
}
