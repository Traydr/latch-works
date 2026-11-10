import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AnimatedImageMimeType,
  encodeAnimationAsMp4,
  type Mp4Encoder,
} from "./animation-mp4.js";

interface AnimationScenario {
  about: string;
  mimeType: AnimatedImageMimeType;
  width: number;
  height: number;
  /* Each frame's duration in microseconds as the decoder reports it; null when it has none. */
  durations: (number | null)[];
}

interface FakeFrame {
  index: number;
  displayWidth: number;
  displayHeight: number;
  duration: number | null;
  close(): void;
}

interface Recording {
  canvas: { width: number; height: number } | null;
  contextOptions: { type: string; alpha: boolean } | null;
  fills: { fillStyle: string; rect: number[] }[];
  draws: { frameIndex: number; x: number; y: number }[];
  frames: { timestampSeconds: number; durationSeconds: number; keyFrame: boolean }[];
  finalized: boolean;
  canceled: boolean;
}

let playing: AnimationScenario | null = null;

let recording: Recording | null = null;

function currentRecording(): Recording {
  if (recording === null) {
    throw new Error("No animation is being recorded.");
  }

  return recording;
}

/* Chromium's ImageDecoder, reduced to what encodeAnimationAsMp4 reads, playing the scenario. */
class FakeImageDecoder {
  static async isTypeSupported(): Promise<boolean> {
    return true;
  }

  readonly tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } };

  readonly #scenario: AnimationScenario;

  constructor() {
    if (playing === null) {
      throw new Error("No animation scenario is playing.");
    }

    this.#scenario = playing;
    this.tracks = {
      ready: Promise.resolve(),
      selectedTrack: { frameCount: playing.durations.length },
    };
  }

  async decode({ frameIndex }: { frameIndex: number }): Promise<{ image: FakeFrame }> {
    return {
      image: {
        index: frameIndex,
        displayWidth: this.#scenario.width,
        displayHeight: this.#scenario.height,
        duration: this.#scenario.durations[frameIndex] ?? null,
        close() {},
      },
    };
  }

  close() {}
}

/* A 2D canvas that records what is painted on it. */
class FakeOffscreenCanvas {
  readonly width: number;

  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(type: string, options: { alpha: boolean }) {
    const record = currentRecording();
    record.contextOptions = { type, alpha: options.alpha };

    const context = {
      fillStyle: "",
      fillRect(x: number, y: number, width: number, height: number) {
        record.fills.push({ fillStyle: context.fillStyle, rect: [x, y, width, height] });
      },
      drawImage(image: FakeFrame, x: number, y: number) {
        record.draws.push({ frameIndex: image.index, x, y });
      },
    };

    return context;
  }
}

/* The encoder seam animation-mp4.ts names for this, recording each frame Mediabunny would get. */
const recordingEncoder: Mp4Encoder = {
  async open(canvas) {
    const record = currentRecording();
    record.canvas = { width: canvas.width, height: canvas.height };

    return {
      async addFrame(timestampSeconds, durationSeconds, options) {
        record.frames.push({ timestampSeconds, durationSeconds, keyFrame: options.keyFrame });
      },
      async finalize() {
        record.finalized = true;

        return new ArrayBuffer(0);
      },
      async cancel() {
        record.canceled = true;
      },
    };
  },
};

const animationScenarios: readonly AnimationScenario[] = [
  { about: "one frame", mimeType: "image/gif", width: 10, height: 10, durations: [100_000] },
  {
    about: "durations around the 10 ms floor, missing ones, and GIF's longest delay",
    mimeType: "image/gif",
    width: 4,
    height: 4,
    durations: [null, 0, 1, 9_999, 10_000, 10_001, 20_000, 99_999, 100_000, null, 655_350_000],
  },
  {
    about: "odd sizes round up to even",
    mimeType: "image/gif",
    width: 3,
    height: 5,
    durations: [50_000, 50_000],
  },
  { about: "one pixel", mimeType: "image/png", width: 1, height: 1, durations: [null] },
  { about: "no pixels", mimeType: "image/webp", width: 0, height: 0, durations: [40_000] },
  {
    about: "large odd sizes",
    mimeType: "image/webp",
    width: 4_095,
    height: 65_535,
    durations: [16_667, 16_667, 16_666],
  },
  {
    about: "timestamps add up in microseconds before they become seconds",
    mimeType: "image/png",
    width: 640,
    height: 360,
    durations: Array.from({ length: 40 }, () => 33_333),
  },
  {
    about: "durations under the floor, many times",
    mimeType: "image/gif",
    width: 2,
    height: 2,
    durations: Array.from({ length: 12 }, (_, index) => index % 3),
  },
  { about: "no frames", mimeType: "image/gif", width: 8, height: 8, durations: [] },
];

async function recordAnimation(scenario: AnimationScenario) {
  playing = scenario;
  recording = {
    canvas: null,
    contextOptions: null,
    fills: [],
    draws: [],
    frames: [],
    finalized: false,
    canceled: false,
  };
  const record = recording;

  try {
    await encodeAnimationAsMp4(
      new Blob([new Uint8Array(1)], { type: scenario.mimeType }),
      scenario.mimeType,
      undefined,
      recordingEncoder,
    );

    return { ...scenario, recorded: record, error: null };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return { ...scenario, recorded: record, error: error.message };
  } finally {
    playing = null;
    recording = null;
  }
}

describe("encodeAnimationAsMp4", () => {
  beforeAll(() => {
    vi.stubGlobal("ImageDecoder", FakeImageDecoder);
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("turns animations into frames with the snapshot's sizes and timings", async () => {
    const cases = [];

    for (const scenario of animationScenarios) {
      cases.push(await recordAnimation(scenario));
    }

    expect(cases).toMatchSnapshot();
  });
});
