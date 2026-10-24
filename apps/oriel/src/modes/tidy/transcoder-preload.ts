import { type FileHandle, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";

import type { TranscoderBridge } from "./shared/bridge";
import { TranscoderChannels, TranscoderJobMessageSchema } from "./shared/messages";

/**
 * File access for the transcoder page, limited to what its jobs name: a job's source may be
 * read and its temp output written, nothing else. The page itself has no Node access.
 */
const readable = new Set<string>();

const writable = new Set<string>();

const handles = new Map<number, FileHandle>();

let nextHandle = 1;

function allowed(set: Set<string>, filePath: string): string {
  const resolved = path.resolve(filePath);

  if (!set.has(resolved)) {
    throw new Error(`The transcoder may not open ${resolved}.`);
  }

  return resolved;
}

function handleOf(handle: number): FileHandle {
  const file = handles.get(handle);

  if (!file) {
    throw new Error("That file is not open.");
  }

  return file;
}

const IdSchema = z.number().int();

const bridge: TranscoderBridge = {
  onJob: (listener) => {
    ipcRenderer.on(TranscoderChannels.job, (_event, raw) => {
      const parsed = TranscoderJobMessageSchema.safeParse(raw);

      if (!parsed.success) {
        return;
      }

      readable.add(path.resolve(parsed.data.job.srcPath));
      writable.add(path.resolve(parsed.data.job.outPath));
      listener(parsed.data);
    });
  },
  onCancel: (listener) => {
    ipcRenderer.on(TranscoderChannels.cancel, (_event, raw) => {
      const id = IdSchema.safeParse(raw);

      if (id.success) {
        listener(id.data);
      }
    });
  },
  send: (message) => ipcRenderer.send(TranscoderChannels.outbound, message),
  openRead: async (filePath) => {
    const file = await open(allowed(readable, filePath), "r");
    const handle = nextHandle++;
    handles.set(handle, file);

    return { handle, size: (await file.stat()).size };
  },
  read: async (handle, start, end) => {
    const buffer = new Uint8Array(end - start);
    const { bytesRead } = await handleOf(handle).read(buffer, 0, buffer.length, start);

    return bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  },
  openWrite: async (filePath) => {
    const file = await open(allowed(writable, filePath), "w");
    const handle = nextHandle++;
    handles.set(handle, file);

    return handle;
  },
  write: async (handle, position, data) => {
    await handleOf(handle).write(data, 0, data.length, position);
  },
  close: async (handle) => {
    await handles.get(handle)?.close();
    handles.delete(handle);
  },
  readFile: async (filePath) => new Uint8Array(await readFile(allowed(readable, filePath))),
  writeFile: async (filePath, data) => {
    await writeFile(allowed(writable, filePath), data);
  },
};

contextBridge.exposeInMainWorld("glazierTranscoder", bridge);
