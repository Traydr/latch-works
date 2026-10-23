import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type createAvifEncoder from "@jsquash/avif/codec/enc/avif_enc.js";
import { encodeStillToAvif } from "@latch-works/glazier-core";
import { createArchiveAvifEncoder } from "@latch-works/media-format";

import { type WorkerInbound, WorkerInboundSchema, type WorkerOutbound } from "../shared/messages";
import { avifCodecModulePath, avifWasmPath, loadSharp, readProcessArgs } from "./runtime";

/**
 * One AVIF encoder process. libavif's wasm build is single-threaded and its heap is per module,
 * so the main process runs several of these side by side, one encode each at a time.
 */
const { parentPort } = process;

if (!parentPort) {
  throw new Error("The AVIF worker must run as a utility process.");
}

const port = parentPort;

const location = {
  packaged: readProcessArgs(process.argv).packaged,
  resourcesPath: process.resourcesPath,
};

const sharp = loadSharp(location);

// One encode at a time: libvips already spreads its decode across threads.
sharp.concurrency(2);

/**
 * The codec's emscripten glue reads `import.meta.url`, which bundling into this CommonJS worker
 * would erase, so the unmodified module is imported from disk at run time.
 */
async function loadCodecFactory(): Promise<typeof createAvifEncoder> {
  const module = await import(/* @vite-ignore */ pathToFileURL(avifCodecModulePath(location)).href);

  return module.default;
}

const encodeRgba = createArchiveAvifEncoder(async () => {
  const createEncoder = await loadCodecFactory();

  return createEncoder({ wasmBinary: await readFile(avifWasmPath(location)), noInitialRun: true });
});

function post(message: WorkerOutbound): void {
  port.postMessage(message);
}

const queue: WorkerInbound[] = [];

let busy = false;

async function drain(): Promise<void> {
  if (busy) {
    return;
  }

  busy = true;

  for (let next = queue.shift(); next; next = queue.shift()) {
    try {
      const result = await encodeStillToAvif(sharp, encodeRgba, next.request);
      post({ type: "encoded", id: next.id, result });
    } catch (error) {
      post({
        type: "encode-failed",
        id: next.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  busy = false;
}

port.on("message", (messageEvent) => {
  const parsed = WorkerInboundSchema.safeParse(messageEvent.data);

  if (parsed.success) {
    queue.push(parsed.data);
    void drain();
  }
});

post({ type: "ready" });
