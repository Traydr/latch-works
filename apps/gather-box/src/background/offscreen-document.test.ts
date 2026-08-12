import { describe, expect, it, vi } from "vitest";
import { OffscreenDocument } from "./offscreen-document";

describe("OffscreenDocument", () => {
  it("reuses an existing offscreen execution context", async () => {
    const platform = {
      getContexts: vi.fn().mockResolvedValue([{}]),
      getUrl: vi.fn().mockReturnValue("chrome-extension://test/offscreen/offscreen.html"),
      createDocument: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn()
    };

    await new OffscreenDocument(platform).ensure();

    expect(platform.createDocument).not.toHaveBeenCalled();
  });

  it("reports whether an execution document is already open", async () => {
    const platform = {
      getContexts: vi.fn().mockResolvedValue([{}]),
      getUrl: vi.fn().mockReturnValue("chrome-extension://test/offscreen/offscreen.html"),
      createDocument: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn()
    };

    await expect(new OffscreenDocument(platform).isOpen()).resolves.toBe(true);
  });

  it("does not request executor status when no offscreen document exists", async () => {
    const sendMessage = vi.fn();
    const platform = {
      getContexts: vi.fn().mockResolvedValue([]),
      getUrl: vi.fn().mockReturnValue("chrome-extension://test/offscreen/offscreen.html"),
      createDocument: vi.fn().mockResolvedValue(undefined),
      sendMessage
    };

    await expect(new OffscreenDocument(platform).getActiveRunId()).resolves.toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports the single active executor run", async () => {
    const platform = {
      getContexts: vi.fn().mockResolvedValue([{}]),
      getUrl: vi.fn().mockReturnValue("chrome-extension://test/offscreen/offscreen.html"),
      createDocument: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ activeRunId: "run-1" })
    };

    await expect(new OffscreenDocument(platform).getActiveRunId()).resolves.toBe("run-1");
  });

  it("serializes concurrent creation attempts", async () => {
    let release: (() => void) | undefined;
    const platform = {
      getContexts: vi.fn().mockResolvedValue([]),
      getUrl: vi.fn().mockReturnValue("chrome-extension://test/offscreen/offscreen.html"),
      createDocument: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      ),
      sendMessage: vi.fn()
    };
    const document = new OffscreenDocument(platform);

    const first = document.ensure();
    const second = document.ensure();
    await vi.waitFor(() => expect(platform.createDocument).toHaveBeenCalledTimes(1));
    release?.();
    await Promise.all([first, second]);

    expect(platform.createDocument).toHaveBeenCalledTimes(1);
  });
});
