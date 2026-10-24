import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from "electron";
import { z } from "zod";

import { lockstepApi } from "./modes/sync/preload-api";
import { glazierBridge } from "./modes/tidy/preload-api";
import { createFrameViewApi } from "./modes/view/preload/frameViewApi";
import {
  AboutSchema,
  type Json,
  KnownFolderSchema,
  type OrielBridge,
  ShellChannels,
  ShellCommandSchema,
} from "./shared/shell";

const oriel: OrielBridge = {
  platform: process.platform,
  setMode: (mode) => ipcRenderer.send(ShellChannels.setMode, mode),
  about: async () => AboutSchema.parse(await ipcRenderer.invoke(ShellChannels.about)),
  importOldApps: () => ipcRenderer.send(ShellChannels.importOldApps),
  revealDataFolder: () => ipcRenderer.send(ShellChannels.revealDataFolder),
  folders: async () =>
    z.array(KnownFolderSchema).parse(await ipcRenderer.invoke(ShellChannels.folders)),
  openInView: async (target) =>
    z.boolean().parse(await ipcRenderer.invoke(ShellChannels.openInView, target)),
  onCommand: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: Json) => {
      const command = ShellCommandSchema.safeParse(payload);

      if (command.success) {
        listener(command.data);
      }
    };

    ipcRenderer.on(ShellChannels.command, handler);

    return () => {
      ipcRenderer.removeListener(ShellChannels.command, handler);
    };
  },
};

contextBridge.exposeInMainWorld("oriel", oriel);

// Each mode keeps the bridge its standalone app's renderer already speaks.
contextBridge.exposeInMainWorld("lockstep", lockstepApi);

contextBridge.exposeInMainWorld("glazier", glazierBridge);

contextBridge.exposeInMainWorld(
  "frameView",
  createFrameViewApi(
    {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      subscribe: (channel, listener) => {
        const handler = (_event: IpcRendererEvent, payload: Json) => listener(payload);

        ipcRenderer.on(channel, handler);

        return () => {
          ipcRenderer.removeListener(channel, handler);
        };
      },
    },
    (file) => webUtils.getPathForFile(file),
  ),
);
