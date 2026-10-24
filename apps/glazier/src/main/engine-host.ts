import os from "node:os";
import path from "node:path";

import {
  type EngineEvent,
  type EngineMethodName,
  EngineMethods,
} from "@latch-works/glazier-core/contract";
import { type UtilityProcess, utilityProcess } from "electron";

import { type EngineInbound, EngineOutboundSchema, type Json } from "../shared/messages";
import { AvifPool } from "./avif-pool";
import { TranscoderHost } from "./transcoder-host";

interface PendingCall {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
}

export interface EngineHostOptions {
  dataDir: string;
  packaged: boolean;
  onEvent: (event: EngineEvent) => void;
}

/**
 * Starts the engine utility process and the encoders it needs, and routes between them: engine
 * calls from the renderer, AVIF encodes to the worker pool, transcodes to the hidden window.
 */
export class EngineHost {
  private engine: UtilityProcess | null = null;

  private ready: Promise<void> | null = null;

  private readonly pending = new Map<number, PendingCall>();

  private nextCallId = 1;

  private readonly pool: AvifPool;

  private readonly transcoder: TranscoderHost;

  private authorizedRoots: string[] = [];

  private capabilities: {
    video: { avc: boolean; hevc: boolean; av1: boolean };
    aac: boolean;
  } | null = null;

  constructor(private readonly options: EngineHostOptions) {
    const workers = Math.max(1, Math.min(4, os.availableParallelism() - 2));
    this.pool = new AvifPool(workers, [`--packaged=${options.packaged ? "1" : "0"}`]);
    this.transcoder = new TranscoderHost({
      onCapabilities: (video, aac) => {
        this.capabilities = { video, aac };
        this.send({ type: "capabilities", video, aac });
      },
    });
  }

  start(): Promise<void> {
    this.transcoder.start();

    return this.ensureEngine();
  }

  dispose(): void {
    this.engine?.kill();
    this.engine = null;
    this.pool.dispose();
    this.transcoder.dispose();
  }

  async call(method: EngineMethodName, input: Json): Promise<Json> {
    await this.ensureEngine();

    return new Promise((resolve, reject) => {
      const id = this.nextCallId++;
      this.pending.set(id, { resolve, reject });
      this.send({ type: "call", id, method, input });
    });
  }

  /** Whether a path lies inside a configured root or that root's holding folder. */
  isAuthorized(target: string): boolean {
    const resolved = path.resolve(target);

    return this.authorizedRoots.some((root) => {
      const relative = path.relative(root, resolved);

      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
  }

  private send(message: EngineInbound): void {
    this.engine?.postMessage(message);
  }

  private ensureEngine(): Promise<void> {
    if (this.ready) {
      return this.ready;
    }

    this.ready = new Promise((resolve, reject) => {
      const child = utilityProcess.fork(
        path.join(__dirname, "engine-process.cjs"),
        [
          `--packaged=${this.options.packaged ? "1" : "0"}`,
          `--data-dir=${this.options.dataDir}`,
          `--concurrency=${Math.max(1, Math.min(4, os.availableParallelism() - 2))}`,
        ],
        { serviceName: "Glazier engine" },
      );

      this.engine = child;

      child.on("message", (raw) => {
        const parsed = EngineOutboundSchema.safeParse(raw);

        if (!parsed.success) {
          console.warn(
            `[glazier:main] dropped a malformed engine message: ${parsed.error.message}`,
          );

          return;
        }

        const message = parsed.data;

        switch (message.type) {
          case "ready":
            if (this.capabilities) {
              this.send({ type: "capabilities", ...this.capabilities });
            }

            void this.refreshAuthorizedRoots();
            resolve();

            return;
          case "result":
            this.pending.get(message.id)?.resolve(message.value);
            this.pending.delete(message.id);

            return;
          case "error":
            this.pending.get(message.id)?.reject(new Error(message.message));
            this.pending.delete(message.id);

            return;
          case "event":
            if (message.event.kind === "roots-changed") {
              this.authorizedRoots = message.event.roots.map((root) => root.path);
              // Each root's holding folder, which lives outside it, follows from the engine.
              void this.refreshAuthorizedRoots();
            }

            this.options.onEvent(message.event);

            return;
          case "encode":
            this.pool.encode(message.id, message.request).then(
              (result) => this.send({ type: "encoded", id: message.id, result }),
              (error: Error) =>
                this.send({ type: "encode-failed", id: message.id, message: error.message }),
            );

            return;
          case "cancel-encode":
            this.pool.cancel(message.id);

            return;
          case "transcode":
            this.transcoder
              .transcode(message.id, message.job, (ratio) =>
                this.send({ type: "transcode-progress", id: message.id, ratio }),
              )
              .then(
                () => this.send({ type: "transcoded", id: message.id }),
                (error: Error) =>
                  this.send({ type: "transcode-failed", id: message.id, message: error.message }),
              );

            return;
          case "cancel-transcode":
            this.transcoder.cancel(message.id);

            return;
          default: {
            const _exhaustive: never = message;

            return _exhaustive;
          }
        }
      });

      child.on("exit", (code) => {
        this.engine = null;
        this.ready = null;

        for (const pending of this.pending.values()) {
          pending.reject(new Error(`The Glazier engine stopped (exit ${code}).`));
        }

        this.pending.clear();
        reject(new Error(`The Glazier engine stopped (exit ${code}).`));
      });
    });

    return this.ready;
  }

  private async refreshAuthorizedRoots(): Promise<void> {
    try {
      this.authorizedRoots = EngineMethods.authorizedRoots.output.parse(
        await this.call("authorizedRoots", {}),
      );
    } catch {
      // The next roots-changed event fills the list.
    }
  }
}
