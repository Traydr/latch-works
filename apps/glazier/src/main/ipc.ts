import { EngineMethodNameSchema, EngineMethods } from "@latch-works/glazier-core/contract";
import { type BrowserWindow, dialog, ipcMain, shell } from "electron";

import {
  type CallResult,
  type EmptyHoldingResult,
  JsonSchema,
  PathArgSchema,
  RendererChannels,
  RootArgSchema,
} from "../shared/messages";
import type { EngineHost } from "./engine-host";

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

  const pickFolder = async (title: string) => {
    const window = getWindow();
    const options = { title, properties: ["openDirectory" as const, "createDirectory" as const] };

    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);

    return result.canceled ? null : (result.filePaths[0] ?? null);
  };

  ipcMain.handle(RendererChannels.pickRoot, () => pickFolder("Add an archive root"));

  ipcMain.handle(RendererChannels.pickFolder, () => pickFolder("Move to folder"));

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
