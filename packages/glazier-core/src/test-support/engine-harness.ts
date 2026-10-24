import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import createAvifEncoder from "@jsquash/avif/codec/enc/avif_enc.js";
import { createArchiveAvifEncoder } from "@latch-works/media-format";
import sharp from "sharp";

import type { EngineEvent, EngineMethodName, EngineOutput, Job } from "../contract.js";
import { EngineMethods } from "../contract.js";
import { GlazierEngine, type JsonValue } from "../engine/engine.js";
import type { MediaToolkit } from "../media/toolkit.js";
import { encodeStillToAvif, type StillEncoder, type Transcoder } from "../optimize/encoders.js";

const require = createRequire(import.meta.url);

function findTool(name: string): string | null {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const testToolkit: MediaToolkit = {
  sharp,
  ffmpegPath: findTool("ffmpeg"),
  ffprobePath: findTool("ffprobe"),
};

const encodeRgba = createArchiveAvifEncoder(async () =>
  createAvifEncoder({
    wasmBinary: await readFile(require.resolve("@jsquash/avif/codec/enc/avif_enc.wasm")),
    noInitialRun: true,
  }),
);

/** The archive AVIF encoder, run in this process instead of a worker pool. */
const inlineStillEncoder: StillEncoder = {
  encode: (request) => encodeStillToAvif(sharp, encodeRgba, request),
};

/** Node has no WebCodecs; video conversions are covered by the desktop e2e suite. */
const unavailableTranscoder: Transcoder = {
  transcode: async () => {
    throw new Error("No transcoder in unit tests.");
  },
};

export interface EngineHarness {
  engine: GlazierEngine;
  call<M extends EngineMethodName>(method: M, input: JsonValue): Promise<EngineOutput<M>>;
  /** Resolves once the job finishes, rejecting if it fails. */
  settle(job: Job): Promise<Job>;
  /** Resolves once every job queued so far has finished. */
  idle(): Promise<void>;
}

export async function openEngine(dataDir: string): Promise<EngineHarness> {
  const listeners = new Set<(event: EngineEvent) => void>();

  const engine = await GlazierEngine.open({
    dataDir,
    toolkit: testToolkit,
    stillEncoder: inlineStillEncoder,
    transcoder: unavailableTranscoder,
    stillConcurrency: 2,
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  });

  const call = async <M extends EngineMethodName>(method: M, input: JsonValue) => {
    // Output is parsed the way the renderer parses it, so the contract is exercised too.
    const output = await engine.dispatch(method, input);

    // SAFETY: `EngineMethods[method].output` is the schema `EngineOutput<M>` is inferred from.
    return EngineMethods[method].output.parse(output) as EngineOutput<M>;
  };

  const settle = (job: Job) =>
    new Promise<Job>((resolve, reject) => {
      const check = (current: Job) => {
        if (current.id !== job.id) {
          return;
        }

        if (current.state === "done") {
          listeners.delete(listener);
          resolve(current);
        } else if (current.state === "failed" || current.state === "cancelled") {
          listeners.delete(listener);
          reject(new Error(`${current.label} ${current.state}: ${current.message}`));
        }
      };

      const listener = (event: EngineEvent) => {
        if (event.kind === "job") {
          check(event.job);
        }
      };

      listeners.add(listener);
    });

  const idle = async () => {
    for (;;) {
      const state = await call("getState", {});

      const active = state.jobs.filter(
        (job) => job.state === "queued" || job.state === "running" || job.state === "paused",
      );

      if (active.length === 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  return { engine, call, settle, idle };
}

/** A picture with enough structure for perceptual hashing: gradients, bands and a disc. */
export function testPicture(seed: number, width = 640, height = 480) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 640 480">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${(seed * 47) % 360} 70% 40%)"/>
      <stop offset="1" stop-color="hsl(${(seed * 47 + 160) % 360} 60% 70%)"/>
    </linearGradient></defs>
    <rect width="640" height="480" fill="url(#g)"/>
    <circle cx="${120 + ((seed * 83) % 400)}" cy="${100 + ((seed * 61) % 280)}" r="${60 + (seed % 5) * 20}" fill="#fff8"/>
    <rect x="${(seed * 37) % 500}" y="300" width="140" height="${40 + (seed % 3) * 30}" fill="#0008"/>
    <path d="M0 ${200 + (seed % 7) * 20} Q 320 ${seed % 2 ? 0 : 480} 640 240" stroke="#222" stroke-width="18" fill="none"/>
  </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height);
}
