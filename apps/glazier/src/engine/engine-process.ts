import {
  type EncoderCapabilities,
  GlazierEngine,
  killRunningTools,
  type StillEncodeRequest,
  type StillEncodeResult,
  type StillEncoder,
  type TranscodeJob,
  type TranscodeOutcome,
  type Transcoder,
} from "@latch-works/glazier-core";

import { EngineInboundSchema, type EngineOutbound } from "../shared/messages";
import { loadToolkit, readProcessArgs } from "./runtime";

/**
 * The engine's utility process: the catalog, scans and plan execution, off Electron's main
 * thread. It talks only to the main process, which routes AVIF encodes to the worker pool and
 * transcodes to the hidden Mediabunny window.
 */
const { parentPort } = process;

if (!parentPort) {
  throw new Error("The Glazier engine must run as a utility process.");
}

const port = parentPort;

const args = readProcessArgs(process.argv);

function post(message: EngineOutbound): void {
  port.postMessage(message);
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  onProgress?: (ratio: number) => void;
}

let nextRequestId = 1;

const pendingEncodes = new Map<number, Pending<StillEncodeResult>>();

const pendingTranscodes = new Map<number, Pending<TranscodeOutcome>>();

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

const stillEncoder: StillEncoder = {
  encode: (request: StillEncodeRequest, signal: AbortSignal) =>
    new Promise((resolve, reject) => {
      const id = nextRequestId++;

      if (signal.aborted) {
        reject(abortError());

        return;
      }

      pendingEncodes.set(id, { resolve, reject });
      signal.addEventListener(
        "abort",
        () => {
          if (pendingEncodes.delete(id)) {
            post({ type: "cancel-encode", id });
            reject(abortError());
          }
        },
        { once: true },
      );
      post({ type: "encode", id, request });
    }),
};

const transcoder: Transcoder = {
  transcode: (job: TranscodeJob, signal: AbortSignal, onProgress: (ratio: number) => void) =>
    new Promise((resolve, reject) => {
      const id = nextRequestId++;

      if (signal.aborted) {
        reject(abortError());

        return;
      }

      pendingTranscodes.set(id, { resolve, reject, onProgress });
      signal.addEventListener(
        "abort",
        () => {
          if (pendingTranscodes.delete(id)) {
            post({ type: "cancel-transcode", id });
            reject(abortError());
          }
        },
        { once: true },
      );
      post({ type: "transcode", id, job });
    }),
};

async function start(): Promise<void> {
  const engine = await GlazierEngine.open({
    dataDir: args.dataDir,
    toolkit: loadToolkit({ packaged: args.packaged, resourcesPath: process.resourcesPath }),
    stillEncoder,
    transcoder,
    stillConcurrency: args.concurrency,
    emit: (event) => post({ type: "event", event }),
  });

  port.on("message", (messageEvent) => {
    const parsed = EngineInboundSchema.safeParse(messageEvent.data);

    if (!parsed.success) {
      console.warn(`[glazier:engine] dropped a malformed message: ${parsed.error.message}`);

      return;
    }

    const message = parsed.data;

    switch (message.type) {
      case "call":
        engine.dispatch(message.method, message.input).then(
          (value) => post({ type: "result", id: message.id, value }),
          (error: Error) => post({ type: "error", id: message.id, message: error.message }),
        );

        return;
      case "encoded":
        pendingEncodes.get(message.id)?.resolve(message.result);
        pendingEncodes.delete(message.id);

        return;
      case "encode-failed":
        pendingEncodes.get(message.id)?.reject(new Error(message.message));
        pendingEncodes.delete(message.id);

        return;
      case "transcoded":
        pendingTranscodes.get(message.id)?.resolve({ via: "mediabunny", note: null });
        pendingTranscodes.delete(message.id);

        return;
      case "transcode-failed":
        pendingTranscodes.get(message.id)?.reject(new Error(message.message));
        pendingTranscodes.delete(message.id);

        return;
      case "transcode-progress":
        pendingTranscodes.get(message.id)?.onProgress?.(message.ratio);

        return;
      case "capabilities": {
        const video: EncoderCapabilities["video"] = message.video;
        engine.setEncoderCapabilities(video, message.aac);

        return;
      }

      default: {
        const _exhaustive: never = message;

        return _exhaustive;
      }
    }
  });

  post({ type: "ready" });
}

// The main process stops this one with SIGTERM when the app quits. ffmpeg and ffprobe children
// would outlive it and keep converting, so they go first.
process.on("SIGTERM", () => {
  killRunningTools();
  process.exit(0);
});

start().catch((error: Error) => {
  console.error(`[glazier:engine] failed to start: ${error.message}`);
  process.exit(1);
});
