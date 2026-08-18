import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeGifAsMp4, type Mp4Encoder, type Mp4VideoSink } from "./gif-mp4-encoder";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface CanvasSize {
  width: number;
  height: number;
}

interface RecordingEncoder extends Mp4Encoder {
  addFrame: Mp4VideoSink["addFrame"];
  cancel: Mp4VideoSink["cancel"];
  finalize: Mp4VideoSink["finalize"];
  video: ArrayBuffer;
}

/** Stands in for the mediabunny muxer, recording the frame timing the converter asks for. */
function recordingEncoder(): RecordingEncoder {
  const video = new ArrayBuffer(2);
  const addFrame = vi.fn<Mp4VideoSink["addFrame"]>(async () => undefined);
  const cancel = vi.fn<Mp4VideoSink["cancel"]>(async () => undefined);
  const finalize = vi.fn<Mp4VideoSink["finalize"]>(async () => video);

  return {
    addFrame,
    cancel,
    finalize,
    video,
    open: async () => ({ addFrame, cancel, finalize })
  };
}

describe("GIF MP4 encoder", () => {
  it("writes timed frames, pads odd dimensions, and closes decoder resources", async () => {
    const browser = installBrowserFakes([50_000, undefined]);
    const encoder = recordingEncoder();

    const result = await encodeGifAsMp4(new Blob(["gif"]), undefined, encoder);

    expect(result).toBe(encoder.video);
    expect(browser.canvasSize).toEqual({ width: 4, height: 6 });
    expect(vi.mocked(encoder.addFrame).mock.calls).toEqual([
      [0, 0.05, { keyFrame: true }],
      [0.05, 0.1, { keyFrame: false }]
    ]);
    expect(browser.frameClose).toHaveBeenCalledTimes(2);
    expect(browser.decoderClose).toHaveBeenCalledOnce();
    expect(encoder.finalize).toHaveBeenCalledOnce();
    expect(encoder.cancel).not.toHaveBeenCalled();
  });

  it("cancels the output and closes resources when finalization fails", async () => {
    const browser = installBrowserFakes([50_000]);
    const encoder = recordingEncoder();
    vi.mocked(encoder.finalize).mockRejectedValueOnce(new Error("finalize failed"));

    await expect(encodeGifAsMp4(new Blob(["gif"]), undefined, encoder)).rejects.toThrow(
      "finalize failed"
    );

    expect(encoder.cancel).toHaveBeenCalledOnce();
    expect(browser.frameClose).toHaveBeenCalledOnce();
    expect(browser.decoderClose).toHaveBeenCalledOnce();
  });

  it("stops before another frame after cancellation", async () => {
    const controller = new AbortController();
    const browser = installBrowserFakes([50_000, 50_000]);
    const encoder = recordingEncoder();
    vi.mocked(encoder.addFrame).mockImplementationOnce(async () => {
      controller.abort();
    });

    await expect(
      encodeGifAsMp4(new Blob(["gif"]), controller.signal, encoder)
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(browser.decode).toHaveBeenCalledOnce();
    expect(browser.frameClose).toHaveBeenCalledOnce();
    expect(browser.decoderClose).toHaveBeenCalledOnce();
    expect(encoder.cancel).toHaveBeenCalledOnce();
  });
});

interface BrowserFakes {
  canvasSize: CanvasSize | null;
  decode: ReturnType<typeof vi.fn>;
  decoderClose: ReturnType<typeof vi.fn>;
  frameClose: ReturnType<typeof vi.fn>;
}

function installBrowserFakes(durations: Array<number | undefined>) {
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

  const result: BrowserFakes = { canvasSize: null, decode, decoderClose, frameClose };

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
