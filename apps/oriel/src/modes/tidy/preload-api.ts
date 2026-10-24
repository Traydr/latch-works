import { type IpcRendererEvent, ipcRenderer, webUtils } from "electron";

import type { GlazierBridge } from "./shared/bridge";
import { type Json, RendererChannels } from "./shared/messages";

/** Tidy's half of the preload bridge, which Oriel exposes as `window.glazier`. */
export const glazierBridge: GlazierBridge = {
  platform: process.platform,
  call: (method, input) => ipcRenderer.invoke(RendererChannels.call, method, input),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: Json) => listener(payload);

    ipcRenderer.on(RendererChannels.event, handler);

    return () => {
      ipcRenderer.removeListener(RendererChannels.event, handler);
    };
  },
  listFolder: (folder) => ipcRenderer.invoke(RendererChannels.listFolder, folder),
  folderPlaces: () => ipcRenderer.invoke(RendererChannels.folderPlaces),
  reveal: (filePath) => ipcRenderer.invoke(RendererChannels.reveal, filePath),
  open: (filePath) => ipcRenderer.invoke(RendererChannels.open, filePath),
  quickLook: (filePath) => ipcRenderer.invoke(RendererChannels.quickLook, filePath),
  emptyHolding: (rootId) => ipcRenderer.invoke(RendererChannels.emptyHolding, rootId),
  showMenu: (entries) => ipcRenderer.invoke(RendererChannels.showMenu, entries),
  confirm: (request) => ipcRenderer.invoke(RendererChannels.confirm, request),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onCommand: (listener) => {
    const handler = (_event: IpcRendererEvent, command: Json) => listener(command);

    ipcRenderer.on(RendererChannels.command, handler);

    return () => {
      ipcRenderer.removeListener(RendererChannels.command, handler);
    };
  },
};
