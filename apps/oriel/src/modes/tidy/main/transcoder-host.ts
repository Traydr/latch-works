import path from "node:path";

import type { TranscodeJob } from "@latch-works/glazier-core";
import { BrowserWindow, ipcMain } from "electron";

import {
  TranscoderChannels,
  type TranscoderJobMessage,
  TranscoderOutboundSchema,
} from "../shared/messages";

interface Running {
  id: number;
  job: TranscodeJob;
  resolve: () => void;
  reject: (error: Error) => void;
  onProgress: (ratio: number) => void;
}

export interface TranscoderCallbacks {
  onCapabilities: (video: { avc: boolean; hevc: boolean; av1: boolean }, aac: boolean) => void;
}

/**
 * The hidden window that converts videos and animations with Mediabunny. It is a Chromium page,
 * so WebCodecs gives it the machine's hardware encoders. One job runs at a time; a crashed page
 * fails its job and is reloaded.
 */
export class TranscoderHost {
  private window: BrowserWindow | null = null;

  private readonly queue: Running[] = [];

  private running: Running | null = null;

  /** Whether the page finished loading; jobs sent earlier would be lost. */
  private loaded = false;

  constructor(private readonly callbacks: TranscoderCallbacks) {
    ipcMain.on(TranscoderChannels.outbound, (event, raw) => {
      if (event.sender !== this.window?.webContents) {
        return;
      }

      const parsed = TranscoderOutboundSchema.safeParse(raw);

      if (!parsed.success) {
        return;
      }

      const message = parsed.data;

      switch (message.type) {
        case "capabilities":
          this.callbacks.onCapabilities(message.video, message.aac);

          return;
        case "progress":
          if (this.running?.id === message.id) {
            this.running.onProgress(message.ratio);
          }

          return;
        case "done":
        case "failed": {
          const running = this.running;

          if (running?.id !== message.id) {
            return;
          }

          this.running = null;

          if (message.type === "done") {
            running.resolve();
          } else {
            running.reject(new Error(message.message));
          }

          this.pump();

          return;
        }

        default: {
          const _exhaustive: never = message;

          return _exhaustive;
        }
      }
    });
  }

  start(): void {
    this.ensureWindow();
  }

  transcode(id: number, job: TranscodeJob, onProgress: (ratio: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id, job, resolve, reject, onProgress });
      this.pump();
    });
  }

  cancel(id: number): void {
    const index = this.queue.findIndex((entry) => entry.id === id);

    if (index >= 0) {
      this.queue.splice(index, 1);

      return;
    }

    if (this.running?.id === id) {
      this.window?.webContents.send(TranscoderChannels.cancel, id);
    }
  }

  dispose(): void {
    this.window?.destroy();
    this.window = null;
  }

  private pump(): void {
    if (this.running !== null) {
      return;
    }

    const next = this.queue.shift();

    if (!next) {
      return;
    }

    this.running = next;
    this.ensureWindow();
    this.sendRunning();
  }

  private sendRunning(): void {
    if (!this.loaded || this.running === null || !this.window) {
      return;
    }

    const message: TranscoderJobMessage = { id: this.running.id, job: this.running.job };
    this.window.webContents.send(TranscoderChannels.job, message);
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // The preload reads and writes the job's files; the page itself has no Node access.
        sandbox: false,
        // A hidden window is throttled by default, which would stall long conversions.
        backgroundThrottling: false,
        preload: path.join(__dirname, "transcoder-preload.cjs"),
      },
    });

    this.window = window;

    this.loaded = false;

    window.webContents.on("did-finish-load", () => {
      this.loaded = true;
      this.sendRunning();
    });

    window.webContents.on("render-process-gone", (_event, details) => {
      const running = this.running;
      this.running = null;
      this.loaded = false;
      running?.reject(new Error(`The transcoder stopped (${details.reason}).`));
      this.window = null;
      window.destroy();
      this.pump();
    });

    if (TRANSCODER_VITE_DEV_SERVER_URL) {
      void window.loadURL(`${TRANSCODER_VITE_DEV_SERVER_URL}/transcoder.html`);
    } else {
      void window.loadFile(
        path.join(__dirname, `../renderer/${TRANSCODER_VITE_NAME}/transcoder.html`),
      );
    }

    return window;
  }
}
