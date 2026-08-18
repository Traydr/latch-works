import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer } from 'electron';

import { createFrameViewApi, type PreloadIpcTransport } from './preload/frameViewApi';
import type { JsonValue } from './shared/contracts';

const transport: PreloadIpcTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  subscribe: (channel, listener) => {
    const wrappedListener = (_event: IpcRendererEvent, payload: JsonValue) => {
      listener(payload);
    };

    ipcRenderer.on(channel, wrappedListener);

    return () => {
      ipcRenderer.removeListener(channel, wrappedListener);
    };
  },
};

contextBridge.exposeInMainWorld('frameView', createFrameViewApi(transport));
