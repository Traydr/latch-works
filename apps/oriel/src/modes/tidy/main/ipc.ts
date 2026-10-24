import { EngineMethodNameSchema, EngineMethods } from "@latch-works/glazier-core/contract";
import {
  type BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from "electron";
import { z } from "zod";

import {
  type CallResult,
  ConfirmRequestSchema,
  type EmptyHoldingResult,
  JsonSchema,
  type MenuEntry,
  MenuEntrySchema,
  PathArgSchema,
  RendererChannels,
  RootArgSchema,
} from "../shared/messages";
import type { EngineHost } from "./engine-host";
import { folderPlaces, listFolder } from "./folders";

/** Renderer IPC: engine calls pass through after their input is parsed; the rest is Electron's. */
export function registerIpc(host: EngineHost, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    RendererChannels.call,
    async (_event, rawMethod, rawInput): Promise<CallResult> => {
      const method = EngineMethodNameSchema.safeParse(rawMethod);

      if (!method.success) {
        return { ok: false, message: "Unknown engine method." };
      }

      const input = EngineMethods[method.data].input.safeParse(rawInput);

      if (!input.success) {
        return { ok: false, message: `Invalid ${method.data} request: ${input.error.message}` };
      }

      try {
        return { ok: true, value: await host.call(method.data, JsonSchema.parse(input.data)) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // The in-app folder picker reads folder names only; what it picks goes through the engine,
  // which checks it like any other path.
  ipcMain.handle(RendererChannels.listFolder, (_event, raw) =>
    listFolder(PathArgSchema.parse(raw)),
  );

  ipcMain.handle(RendererChannels.folderPlaces, () => folderPlaces());

  ipcMain.handle(RendererChannels.reveal, (_event, raw) => {
    const target = PathArgSchema.safeParse(raw);

    if (target.success && host.isAuthorized(target.data)) {
      shell.showItemInFolder(target.data);
    }
  });

  ipcMain.handle(RendererChannels.open, async (_event, raw) => {
    const target = PathArgSchema.safeParse(raw);

    if (target.success && host.isAuthorized(target.data)) {
      await shell.openPath(target.data);
    }
  });

  ipcMain.handle(RendererChannels.quickLook, (_event, raw) => {
    const target = PathArgSchema.safeParse(raw);

    if (target.success && host.isAuthorized(target.data)) {
      getWindow()?.previewFile(target.data);
    }
  });

  ipcMain.handle(
    RendererChannels.showMenu,
    (_event, raw) =>
      new Promise<string | null>((resolve) => {
        const entries = z.array(MenuEntrySchema).parse(raw);
        const menu = Menu.buildFromTemplate(entries.map((entry) => toMenuItem(entry, resolve)));
        const window = getWindow();

        // A click can arrive after the menu reports closing, so "nothing chosen" waits a moment.
        const dismissed = () => setTimeout(() => resolve(null), 120);

        if (window) {
          menu.popup({ window, callback: dismissed });
        } else {
          dismissed();
        }
      }),
  );

  ipcMain.handle(RendererChannels.confirm, async (_event, raw) => {
    const request = ConfirmRequestSchema.parse(raw);
    const window = getWindow();

    const options = {
      type: request.destructive ? ("warning" as const) : ("question" as const),
      message: request.message,
      detail: request.detail,
      buttons: [request.confirmLabel, "Cancel"],
      defaultId: 0,
      cancelId: 1,
    };

    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

    return result.response === 0;
  });

  /**
   * Empties a root's holding folder into the system Trash (the Recycle Bin on Windows), batch by
   * batch. A batch the Trash refuses stays held and is reported.
   */
  ipcMain.handle(
    RendererChannels.emptyHolding,
    async (_event, raw): Promise<EmptyHoldingResult> => {
      const rootId = RootArgSchema.parse(raw);

      const batches = EngineMethods.holdingBatches.output.parse(
        await host.call("holdingBatches", { rootId }),
      );

      const trashed: string[] = [];
      const failed: string[] = [];

      for (const batch of batches) {
        try {
          await shell.trashItem(batch);
          trashed.push(batch);
        } catch (error) {
          failed.push(`${batch}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const { emptied } = EngineMethods.markHoldingEmptied.output.parse(
        await host.call("markHoldingEmptied", { rootId, batchPaths: trashed }),
      );

      return { emptied, failed };
    },
  );
}

function toMenuItem(entry: MenuEntry, choose: (id: string) => void): MenuItemConstructorOptions {
  switch (entry.type) {
    case "separator":
      return { type: "separator" };
    case "item":
      return {
        label: entry.label,
        enabled: entry.enabled ?? true,
        type: entry.checked === undefined ? "normal" : "checkbox",
        checked: entry.checked,
        accelerator: entry.accelerator,
        registerAccelerator: false,
        sublabel: entry.sublabel,
        click: () => choose(entry.id),
      };
    case "submenu":
      return {
        label: entry.label,
        enabled: entry.enabled ?? true,
        submenu: entry.items.map((item) => toMenuItem(item, choose)),
      };
    default: {
      const _exhaustive: never = entry;

      return _exhaustive;
    }
  }
}
