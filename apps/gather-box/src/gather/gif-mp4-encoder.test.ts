import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeGifAsMp4 } from "./gif-mp4-encoder";

const mediaMocks = vi.hoisted(() => ({
  add: vi.fn<
    (timestamp: number, duration: number, options: { keyFrame: boolean }) => Promise<void>
  >(async () => undefined),
  addVideoTrack: vi.fn(),
  cancel: vi.fn(async () => undefined),
  finalize: vi.fn(async () => undefined),
  start: vi.fn(async () => undefined),
  targetBuffer: new ArrayBuffer(2)
}));

vi.mock("mediabunny", () => ({
  BufferTarget: class {
    buffer = mediaMocks.targetBuffer;
  },
  CanvasSource: class {
    constructor(canvas: OffscreenCanvas) {
      void canvas;
    }

    add(timestamp: number, duration: number, options: { keyFrame: boolean }) {
      return mediaMocks.add(timestamp, duration, options);
    }
  },
  Mp4OutputFormat: class {},
  Output: class {
    state = "pending";

    addVideoTrack(...args: unknown[]) {
      return mediaMocks.addVideoTrack(...args);
    }

    async start() {
      await mediaMocks.start();
      this.state = "started";
    }

    async finalize() {
      await mediaMocks.finalize();
      this.state = "finalized";
    }

    async cancel() {
      await mediaMocks.cancel();
      this.state = "canceled";
    }
  },
  Quality: class {}
}));

beforeEach(() => {
  vi.clearAllMocks();
  mediaMocks.targetBuffer = new ArrayBuffer(2);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GIF MP4 encoder", () => {
  it("writes timed frames, pads odd dimensions, and closes decoder resources", async () => {
    const browser = installBrowserFakes([50_000, undefined]);

    const result = await encodeGifAsMp4(new Blob(["gif"]));

    expect(result).toBe(mediaMocks.targetBuffer);
    expect(browser.canvasSize).toEqual({ width: 4, height: 6 });
    expect(mediaMocks.add.mock.calls).toEqual([
      [0, 0.05, { keyFrame: true }],
      [0.05, 0.1, { keyFrame: false }]
    ]);
    expect(browser.frameClose).toHaveBeenCalledTimes(2);
    expect(browser.decoderClose).toHaveBeenCalledOnce();
    expect(mediaMocks.finalize).toHaveBeenCalledOnce();
    expect(mediaMocks.cancel).not.toHaveBeenCalled();
  });

  it("cancels the output and closes resources when finalization fails", async () => {
    const browser = installBrowserFakes([50_000]);
    mediaMocks.finalize.mockRejectedValueOnce(new Error("finalize failed"));

    await expect(encodeGifAsMp4(new Blob(["gif"]))).rejects.toThrow("finalize failed");

    expect(mediaMocks.cancel).toHaveBeenCalledOnce();
    expect(browser.frameClose).toHaveBeenCalledOnce();
    expect(browser.decoderClose).toHaveBeenCalledOnce();
  });

  it("stops before another frame after cancellation", async () => {
    const controller = new AbortController();
    const browser = installBrowserFakes([50_000, 50_000]);
    mediaMocks.add.mockImplementationOnce(async () => {
      controller.abort();
    });

    await expect(encodeGifAsMp4(new Blob(["gif"]), controller.signal)).rejects.toMatchObject({
      name: "AbortError"
    });

    expect(browser.decode).toHaveBeenCalledOnce();
    expect(browser.frameClose).toHaveBeenCalledOnce();
    expect(browser.decoderClose).toHaveBeenCalledOnce();
    expect(mediaMocks.cancel).toHaveBeenCalledOnce();
  });
});

function installBrowserFakes(durations: Array<number | undefined>): {
  canvasSize: { width: number; height: number } | null;
  decode: ReturnType<typeof vi.fn>;
  decoderClose: ReturnType<typeof vi.fn>;
  frameClose: ReturnType<typeof vi.fn>;
} {
  const frameClose = vi.fn();
  const decoderClose = vi.fn();
  const frames = durations.map((duration) => ({
    image: {
      close: frameClose,
      displayHeight: 5,
      displayWidth: 3,
      duration
    }
  }));
  const decode = vi.fn(async ({ frameIndex }: { frameIndex: number }) => frames[frameIndex]);

  class FakeImageDecoder {
    static isTypeSupported = vi.fn(async () => true);
    readonly tracks = {
      ready: Promise.resolve(),
      selectedTrack: { frameCount: frames.length }
    };

    decode = decode;
    close = decoderClose;
  }

  const result = {
    canvasSize: null as { width: number; height: number } | null,
    decode,
    decoderClose,
    frameClose
  };
  class FakeOffscreenCanvas {
    constructor(width: number, height: number) {
      result.canvasSize = { width, height };
    }

    getContext() {
      return {
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        fillStyle: ""
      };
    }
  }

  vi.stubGlobal("ImageDecoder", FakeImageDecoder);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  return result;
}
