import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

import type { GlazierBridge } from "./shared/bridge";
import { type Json, RendererChannels } from "./shared/messages";

const bridge: GlazierBridge = {
  call: (method, input) => ipcRenderer.invoke(RendererChannels.call, method, input),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: Json) => listener(payload);

    ipcRenderer.on(RendererChannels.event, handler);

    return () => {
      ipcRenderer.removeListener(RendererChannels.event, handler);
    };
  },
  pickRoot: () => ipcRenderer.invoke(RendererChannels.pickRoot),
  pickFolder: () => ipcRenderer.invoke(RendererChannels.pickFolder),
  reveal: (filePath) => ipcRenderer.invoke(RendererChannels.reveal, filePath),
  open: (filePath) => ipcRenderer.invoke(RendererChannels.open, filePath),
  quickLook: (filePath) => ipcRenderer.invoke(RendererChannels.quickLook, filePath),
  emptyHolding: (rootId) => ipcRenderer.invoke(RendererChannels.emptyHolding, rootId),
};

contextBridge.exposeInMainWorld("glazier", bridge);
