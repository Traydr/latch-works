import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

import { type Json, type OrielBridge, ShellChannels, ShellCommandSchema } from "./shared/shell";

const oriel: OrielBridge = {
  platform: process.platform,
  setMode: (mode) => ipcRenderer.send(ShellChannels.setMode, mode),
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
